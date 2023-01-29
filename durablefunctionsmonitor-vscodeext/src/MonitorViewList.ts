// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';

import { ConnStringUtils } from "./ConnStringUtils";

import { AzureConnectionInfo, MonitorView } from "./MonitorView";
import { BackendProcess } from './BackendProcess';
import { StorageConnectionSettings, CreateAuthHeadersForTableStorage, CreateIdentityBasedAuthHeadersForTableStorage } from "./StorageConnectionSettings";
import { FunctionGraphList } from './FunctionGraphList';
import { DeviceTokenCredentials } from '@azure/ms-rest-nodeauth';

// Represents all MonitorViews created so far
export class MonitorViewList {

    public static readonly ConnectionStringHashes = 'ConnectionStringHashes';

    constructor(private _context: vscode.ExtensionContext,
        private _functionGraphList: FunctionGraphList,
        private _getTokenCredentialsForGivenConnectionString: (connString: string) => Promise<AzureConnectionInfo | undefined>,
        private _onViewStatusChanged: () => void,
        private _log: (line: string) => void) {
    }

    isAnyMonitorViewVisible(): boolean {
        return Object.keys(this._monitorViews).some(k => !!this._monitorViews[k] && this._monitorViews[k].isVisible);
    }

    isMonitorViewVisible(connSettings: StorageConnectionSettings): boolean {
        const monitorView = this._monitorViews[connSettings.hashKey];
        return !!monitorView && monitorView.isVisible;
    }

    // Creates a new MonitorView with provided connection settings
    getOrCreateFromStorageConnectionSettings(connSettings: StorageConnectionSettings): MonitorView {

        var monitorView = this._monitorViews[connSettings.hashKey];
        if (!!monitorView) {
            return monitorView;
        }

        monitorView = new MonitorView(this._context,
            this.getOrAddBackend(connSettings),
            connSettings.hubName,
            this._functionGraphList,
            this._getTokenCredentialsForGivenConnectionString,
            this._onViewStatusChanged,
            this._log);
        
        this._monitorViews[connSettings.hashKey] = monitorView;
        return monitorView;
    }

    // Gets an existing (first in the list) MonitorView,
    // or initializes a new one by asking user for connection settings
    async getOrAdd(alwaysCreateNew: boolean): Promise<MonitorView | null> {

        const keys = Object.keys(this._monitorViews);
        if (!alwaysCreateNew && keys.length > 0) {
            return this._monitorViews[keys[0]];
        }

        const connSettings = await this.askForStorageConnectionSettings();

        if (!connSettings) {
            return null;
        }

        if (!connSettings.connStringHashKey) {
            throw new Error(`The provided Connection String seem to be invalid`);
        }

        // Persisting the provided connection string in ExtensionContext.secrets
        await this.saveConnectionString(connSettings);

        return await this.getOrCreateFromStorageConnectionSettings(connSettings);
    }

    firstOrDefault(): MonitorView | null {

        const keys = Object.keys(this._monitorViews);
        if (keys.length <= 0) {
            return null;
        }

        return this._monitorViews[keys[0]];
    }

    // Parses local project files and tries to infer connction settings from them
    getStorageConnectionSettingsFromCurrentProject(defaultTaskHubName?: string): StorageConnectionSettings | null {

        const hostJson = this.readHostJson();

        if (hostJson.storageProviderType === 'mssql') {
            
            const sqlConnectionString = this.getValueFromLocalSettings(hostJson.connectionStringName);
            if (!sqlConnectionString) {
                return null;
            }

            return new StorageConnectionSettings(sqlConnectionString, 'DurableFunctionsHub');
        }

        var hubName: string | undefined = hostJson.hubName;
        if (!hubName) {

            hubName = defaultTaskHubName;
            if (!hubName) {
                return null;
            }
        }

        const storageConnString = this.getValueFromLocalSettings('AzureWebJobsStorage');
        if (!storageConnString) {
            return null;
        }

        return new StorageConnectionSettings(ConnStringUtils.ExpandEmulatorShortcutIfNeeded(storageConnString), hubName);
    }

    // Stops all backend processes and closes all views
    cleanup(): Promise<any> {

        Object.keys(this._monitorViews).map(k => this._monitorViews[k].cleanup());
        this._monitorViews = {};

        const backends = this._backends;
        this._backends = {};
        return Promise.all(Object.keys(backends).map(k => backends[k].cleanup()));
    }

    async detachBackend(storageConnString: string): Promise<any> {

        const connStringHashKey = StorageConnectionSettings.GetConnStringHashKey(storageConnString);

        // Closing all views related to this connection
        for (const key of Object.keys(this._monitorViews)) {
            const monitorView = this._monitorViews[key];

            if (monitorView.storageConnectionSettings.connStringHashKey === connStringHashKey) {

                monitorView.cleanup();
                delete this._monitorViews[key];
            }
        }

        // Stopping background process
        const backendProcess = this._backends[connStringHashKey];
        if (!backendProcess) {
            return;
        }

        await backendProcess.cleanup();

        delete this._backends[connStringHashKey];
    }

    async forgetConnectionString(storageConnString: string): Promise<any> {

        await this.detachBackend(storageConnString);

        const connStringHashKey = StorageConnectionSettings.GetConnStringHashKey(storageConnString);

        this._context.secrets.delete(connStringHashKey);

        let connStringHashes = this._context.globalState.get(MonitorViewList.ConnectionStringHashes) as string[];
        if (!connStringHashes) {
            return;
        }

        let i;
        while ((i = connStringHashes.indexOf(connStringHashKey)) >= 0)
        {
            connStringHashes.splice(i, 1);
        }

        this._context.globalState.update(MonitorViewList.ConnectionStringHashes, connStringHashes);
    }

    getBackendUrl(storageConnString: string): string {

        const backendProcess = this._backends[StorageConnectionSettings.GetConnStringHashKey(storageConnString)];
        return !backendProcess ? '' : backendProcess.backendUrl; 
    }

    showUponDebugSession(connSettingsFromCurrentProject?: StorageConnectionSettings): Promise<MonitorView | null> {

        if (!connSettingsFromCurrentProject) {
            return this.getOrAdd(true);
        }

        return Promise.resolve(this.getOrCreateFromStorageConnectionSettings(connSettingsFromCurrentProject));
    }

    async getPersistedConnStrings(): Promise<string[]> {

        const connStringHashes = this._context.globalState.get(MonitorViewList.ConnectionStringHashes) as string[];
        if (!connStringHashes) {
            return [];
        }

        const result: string[] = [];

        for (const connStringHash of connStringHashes) {

            const connString = await this._context.secrets.get(connStringHash);

            if (!!connString) {
                
                result.push(connString);
            }
        }

        return result;
    }

    private _monitorViews: { [key: string]: MonitorView } = {};
    private _backends: { [key: string]: BackendProcess } = {};

    private getOrAddBackend(connSettings: StorageConnectionSettings): BackendProcess {

        // If a backend for this connection already exists, then just returning the existing one.
        var backendProcess = this._backends[connSettings.connStringHashKey];

        if (!backendProcess) {

            backendProcess = new BackendProcess(
                this._context.extensionPath,
                connSettings,
                () => this.detachBackend(connSettings.storageConnString),
                this._log
            );

            this._backends[connSettings.connStringHashKey] = backendProcess;
        }

        return backendProcess;
    }

    // Obtains Storage Connection String and Hub Name from user
    private askForStorageConnectionSettings(): Promise<StorageConnectionSettings | null> {

        return new Promise<StorageConnectionSettings | null>((resolve, reject) => {

            // Asking the user for Connection String
            var connStringToShow = '';
            const connStringFromLocalSettings = this.getValueFromLocalSettings('AzureWebJobsStorage');

            if (!!connStringFromLocalSettings) {
                connStringToShow = ConnStringUtils.MaskStorageConnString(connStringFromLocalSettings);
            }

            vscode.window.showInputBox({ value: connStringToShow, prompt: 'Storage or MSSQL Connection String' }).then(connString => {

                if (!connString) {
                    resolve(null);
                    return;
                }

                // If the user didn't change it
                if (connString === connStringToShow) {
                    // Then setting it back to non-masked one
                    connString = connStringFromLocalSettings;
                }

                // If it is MSSQL storage provider
                if (!!ConnStringUtils.GetSqlServerName(connString)) {
                    
                    resolve(new StorageConnectionSettings(connString, 'DurableFunctionsHub'));
                    return;
                }

                // Dealing with 'UseDevelopmentStorage=true' early
                connString = ConnStringUtils.ExpandEmulatorShortcutIfNeeded(connString);

                // Asking the user for Hub Name
                var hubName = '';
                const hubPick = vscode.window.createQuickPick();

                hubPick.onDidHide(() => {
                    hubPick.dispose();
                    resolve(null);
                });

                hubPick.onDidChangeSelection(items => {
                    if (!!items && !!items.length) {
                        hubName = items[0].label;
                    }
                });

                // Still allowing to type free text
                hubPick.onDidChangeValue(value => {
                    hubName = value;
                });

                hubPick.onDidAccept(() => {

                    hubPick.hide();
                    resolve(!hubName ? null : new StorageConnectionSettings(connString!, hubName));
                });
                
                hubPick.title = 'Hub Name';

                var hubNameFromHostJson = this.readHostJson().hubName;
                if (!!hubNameFromHostJson) {

                    hubPick.items = [{
                        label: hubNameFromHostJson
                    }];
                    hubPick.placeholder = hubNameFromHostJson;

                } else {

                    hubPick.items = [{
                        label: 'DurableFunctionsHub'
                    }];

                    hubPick.placeholder = 'DurableFunctionsHub';
                }

                // Loading other hub names directly from Table Storage
                this.loadHubNamesFromTableStorage(connString).then(hubNames => {

                    if (hubNames.length > 0) {

                        // Adding loaded names to the list
                        hubPick.items = hubNames.map(label => {
                            return { label: label };
                        });

                        hubPick.placeholder = hubNames[0];
                    }
                });

                hubPick.show();

            }, reject);
        });
    }

    private async loadHubNamesFromTableStorage(storageConnString: string): Promise<string[]> {

        const accountName = ConnStringUtils.GetAccountName(storageConnString);
        const accountKey = ConnStringUtils.GetAccountKey(storageConnString);
        const tableEndpoint = ConnStringUtils.GetTableEndpoint(storageConnString);

        if (!accountName) {
            return [];
        }

        if (!accountKey) {

            const credentials = await this._getTokenCredentialsForGivenConnectionString(storageConnString);
            if (!credentials) {
                
                return [];
            }

            const hubNames = await getTaskHubNamesFromTableStorageWithUserToken(tableEndpoint, accountName, credentials.credentials);
            return hubNames ?? [];

        } else {

            const hubNames = await getTaskHubNamesFromTableStorage(tableEndpoint, accountName, accountKey);
            return hubNames ?? [];
        }
    }

    private getValueFromLocalSettings(valueName: string): string {

        try {
        
            const ws = vscode.workspace;
            if (!!ws.rootPath && fs.existsSync(path.join(ws.rootPath, 'local.settings.json'))) {
    
                const localSettings = JSON.parse(fs.readFileSync(path.join(ws.rootPath, 'local.settings.json'), 'utf8'));
    
                if (!!localSettings.Values && !!localSettings.Values[valueName]) {
                    return localSettings.Values[valueName];
                }
            }
                
        } catch (err) {

            this._log(`Failed to parse local.settings.json: ${!(err as any).message ? err : (err as any).message}\n`);
        }

        return '';
    }

    private readHostJson(): { hubName: string, storageProviderType: 'default' | 'mssql', connectionStringName: string } {

        const result = { hubName: '', storageProviderType: 'default' as any, connectionStringName: '' };

        const ws = vscode.workspace;
        if (!!ws.rootPath && fs.existsSync(path.join(ws.rootPath, 'host.json'))) {

            var hostJson;
            try {

                hostJson = JSON.parse(fs.readFileSync(path.join(ws.rootPath, 'host.json'), 'utf8'));
                
            } catch (err) {

                this._log(`Failed to parse host.json: ${!(err as any).message ? err : (err as any).message}\n`);
                return result;
            }

            if (!!hostJson && !!hostJson.extensions && hostJson.extensions.durableTask) {

                const durableTask = hostJson.extensions.durableTask;
                if (!!durableTask.HubName || !!durableTask.hubName) {
                    result.hubName = !!durableTask.HubName ? durableTask.HubName : durableTask.hubName
                }

                if (!!durableTask.storageProvider && durableTask.storageProvider.type === 'mssql') {
                    result.storageProviderType = 'mssql';
                    result.connectionStringName = durableTask.storageProvider.connectionStringName;
                }
            }
        }
        return result;
    }

    private async saveConnectionString(connSettings: StorageConnectionSettings): Promise<void> {

        let connStringHashes = this._context.globalState.get(MonitorViewList.ConnectionStringHashes) as string[];
        if (!connStringHashes) {
            connStringHashes = [];
        }

        if (!connStringHashes.includes(connSettings.connStringHashKey)) {

            connStringHashes.push(connSettings.connStringHashKey);
        }

        this._context.secrets.store(connSettings.connStringHashKey, connSettings.storageConnString);

        await this._context.globalState.update(MonitorViewList.ConnectionStringHashes, connStringHashes)
    }
}

function getTaskHubNamesFromTableNames(tableNames: string[]): string[] {

    const instancesTables: string[] = tableNames.map((table: any) => table.TableName)
        .filter((tableName: string) => tableName.endsWith('Instances'))
        .map((tableName: string) => tableName.substr(0, tableName.length - 'Instances'.length));

    const historyTables: string[] = tableNames.map((table: any) => table.TableName)
        .filter((tableName: string) => tableName.endsWith('History'))
        .map((tableName: string) => tableName.substr(0, tableName.length - 'History'.length));

    // Considering it to be a hub, if it has both *Instances and *History tables
    return instancesTables.filter(name => historyTables.indexOf(name) >= 0);
}

function fixTableEndpointUrl(tableEndpointUrl: string, accountName: string): string {

    if (!tableEndpointUrl) {
        tableEndpointUrl = `https://${accountName}.table.core.windows.net/`;
    } else if (!tableEndpointUrl.endsWith('/')) {
        tableEndpointUrl += '/';
    }

    return tableEndpointUrl;
}

// Tries to load the list of TaskHub names from a storage account.
// Had to handcraft this code, since @azure/data-tables package is still in beta :(
export async function getTaskHubNamesFromTableStorage(tableEndpointUrl: string, accountName: string, accountKey: string, throwUponError?: boolean): Promise<string[] | null> {

    tableEndpointUrl = fixTableEndpointUrl(tableEndpointUrl, accountName);

    let response: any;
    try {

        // Creating the SharedKeyLite signature to query Table Storage REST API for the list of tables
        const authHeaders = CreateAuthHeadersForTableStorage(accountName, accountKey, tableEndpointUrl);

        response = await axios.get(`${tableEndpointUrl}Tables`, { headers: authHeaders });

    } catch (err) {

        if (!!throwUponError) {
            
            throw err;
        }

        console.log(`Failed to load hub names from table storage. ${(err as any).message}`);
    }    

    if (!response || !response.data || !response.data.value || response.data.value.length <= 0) {
        return null;
    }

    return getTaskHubNamesFromTableNames(response.data.value);
}

// Tries to load the list of TaskHub names from a storage account.
// Had to handcraft this code, since @azure/data-tables package is still in beta :(
export async function getTaskHubNamesFromTableStorageWithUserToken(tableEndpointUrl: string, accountName: string, tokenCredential: DeviceTokenCredentials): Promise<string[] | null> {

    tableEndpointUrl = fixTableEndpointUrl(tableEndpointUrl, accountName);

    let response: any;

    try {

        const authHeaders = await CreateIdentityBasedAuthHeadersForTableStorage(tokenCredential);
        response = await axios.get(`${tableEndpointUrl}Tables`, { headers: authHeaders });
        
    } catch (err) {

        console.log(`Failed to load hub names from table storage with user account. ${(err as any).message}`);
    }

    if (!response || !response.data || !response.data.value || response.data.value.length <= 0) {
        return null;
    }

    return getTaskHubNamesFromTableNames(response.data.value);
}