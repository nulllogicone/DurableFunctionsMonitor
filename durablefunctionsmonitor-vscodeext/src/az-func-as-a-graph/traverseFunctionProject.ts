// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import * as util from 'util';
import { exec } from 'child_process';
const execAsync = util.promisify(exec);

import { FunctionsMap, ProxiesMap, TraverseFunctionResult } from './FunctionsMap';

import {
    getCodeInBrackets, TraversalRegexes, BindingsParser,
    isDotNetProjectAsync, isDotNetIsolatedProjectAsync, posToLineNr, cloneFromGitHub, findFileRecursivelyAsync, isJavaProjectAsync
} from './traverseFunctionProjectUtils';

import { traverseDotNetIsolatedProject, traverseJavaProject } from './traverseDotNetIsolatedOrJavaProject';

// Collects all function.json files in a Functions project. Also tries to supplement them with bindings
// extracted from .Net code (if the project is .Net). Also parses and organizes orchestrators/activities 
// (if the project uses Durable Functions)
export async function traverseFunctionProject(projectFolder: string, log: (s: any) => void)
    : Promise<TraverseFunctionResult> {

    let tempFolders = [];
    
    // If it is a git repo, cloning it
    if (projectFolder.toLowerCase().startsWith('http')) {

        log(`Cloning ${projectFolder}`);

        const gitInfo = await cloneFromGitHub(projectFolder);

        log(`Successfully cloned to ${gitInfo.gitTempFolder}`);

        tempFolders.push(gitInfo.gitTempFolder);
        projectFolder = gitInfo.projectFolder;
    }
    
    const hostJsonMatch = await findFileRecursivelyAsync(projectFolder, 'host.json', false);
    if (!hostJsonMatch) {
        throw new Error('host.json file not found under the provided project path');
    }

    log(`>>> Found host.json at ${hostJsonMatch.filePath}`);

    let hostJsonFolder = path.dirname(hostJsonMatch.filePath);

    // here we should check projectFolder (not hostJsonFolder)
    const isDotNetIsolatedProject = await isDotNetIsolatedProjectAsync(projectFolder);
    let isJavaProject = false;

    if (!isDotNetIsolatedProject) {
        
        const isDotNetProject = await isDotNetProjectAsync(hostJsonFolder);

        // If it is a C# function, we'll need to dotnet publish first
        if (!!isDotNetProject) {

            const publishTempFolder = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dotnet-publish-'));
            tempFolders.push(publishTempFolder);

            log(`>>> Publishing ${hostJsonFolder} to ${publishTempFolder}...`);
            await execAsync(`dotnet publish -o ${publishTempFolder}`, { cwd: hostJsonFolder });
            hostJsonFolder = publishTempFolder;
        }

        isJavaProject = await isJavaProjectAsync(hostJsonFolder);
    }

    let functions: FunctionsMap = {};


    if (!!isJavaProject) {

        functions = await traverseJavaProject(projectFolder);

        // Now enriching it with more info extracted from code
        functions = await mapOrchestratorsAndActivitiesAsync(functions, projectFolder, hostJsonFolder);
        
    }else if (!!isDotNetIsolatedProject) {

        functions = await traverseDotNetIsolatedProject(projectFolder);
        
    } else {

        // Reading function.json files, in parallel
        const promises = (await fs.promises.readdir(hostJsonFolder)).map(async functionName => {

            const fullPath = path.join(hostJsonFolder, functionName);
            const functionJsonFilePath = path.join(fullPath, 'function.json');

            const isDirectory = (await fs.promises.lstat(fullPath)).isDirectory();
            const functionJsonExists = fs.existsSync(functionJsonFilePath);

            if (isDirectory && functionJsonExists) {

                try {
                    const functionJsonString = await fs.promises.readFile(functionJsonFilePath, { encoding: 'utf8' });
                    const functionJson = JSON.parse(functionJsonString);

                    functions[functionName] = { bindings: functionJson.bindings, isCalledBy: [], isSignalledBy: [] };

                } catch (err) {
                    log(`>>> Failed to parse ${functionJsonFilePath}: ${err}`);
                }
            }
        });
        await Promise.all(promises);

        // Now enriching data from function.json with more info extracted from code
        functions = await mapOrchestratorsAndActivitiesAsync(functions, projectFolder, hostJsonFolder);
    }

    // Also reading proxies
    const proxies = await readProxiesJson(projectFolder, log);

    return { functions, proxies, tempFolders, projectFolder };
}

// Tries to read proxies.json file from project folder
async function readProxiesJson(projectFolder: string, log: (s: any) => void): Promise<ProxiesMap> {

    const proxiesJsonPath = path.join(projectFolder, 'proxies.json');
    if (!fs.existsSync(proxiesJsonPath)) {
        return {};
    }
    
    const proxiesJsonString = await fs.promises.readFile(proxiesJsonPath, { encoding: 'utf8' });
    try {

        const proxies = JSON.parse(proxiesJsonString).proxies as ProxiesMap;
        if (!proxies) {
            return {};
        }

        var notAddedToCsProjFile = false;
        if (await isDotNetProjectAsync(projectFolder)) {

            // Also checking that proxies.json is added to .csproj file

            const csProjFile = await findFileRecursivelyAsync(projectFolder, '.+\\.csproj$', true);
            const proxiesJsonEntryRegex = new RegExp(`\\s*=\\s*"proxies.json"\\s*>`);

            if (!!csProjFile && csProjFile.code && (!proxiesJsonEntryRegex.exec(csProjFile.code))) {
                
                notAddedToCsProjFile = true;
            }            
        }

        // Also adding filePath and lineNr
        for (var proxyName in proxies) {

            const proxy = proxies[proxyName];
            proxy.filePath = proxiesJsonPath;
            if (notAddedToCsProjFile) {
                proxy.warningNotAddedToCsProjFile = true;
            }

            const proxyNameRegex = new RegExp(`"${proxyName}"\\s*:`);
            const match = proxyNameRegex.exec(proxiesJsonString);
            if (!!match) {
                
                proxy.pos = match.index;
                proxy.lineNr = posToLineNr(proxiesJsonString, proxy.pos);
            }
        }

        return proxies;

    } catch(err) {

        log(`>>> Failed to parse ${proxiesJsonPath}: ${err}`);
        return {};
    }
}

// Tries to match orchestrations and their activities by parsing source code
async function mapOrchestratorsAndActivitiesAsync(functions: FunctionsMap, projectFolder: string, hostJsonFolder: string): Promise<FunctionsMap> {

    let projectKind: 'dotNet' | 'java' | 'other' = 'other';

    if (await isDotNetProjectAsync(projectFolder)) {
        projectKind = 'dotNet';
    } else if (await isJavaProjectAsync(projectFolder)) {
        projectKind = 'java';
    }

    const functionNames = Object.keys(functions);
    
    const orchestratorNames = functionNames.filter(name => functions[name].bindings.some((b: any) => b.type === 'orchestrationTrigger'));
    const orchestrators = await getFunctionsAndTheirCodesAsync(orchestratorNames, projectKind, projectFolder, hostJsonFolder);

    const activityNames = Object.keys(functions).filter(name => functions[name].bindings.some((b: any) => b.type === 'activityTrigger'));
    const activities = await getFunctionsAndTheirCodesAsync(activityNames, projectKind, projectFolder, hostJsonFolder);

    const entityNames = functionNames.filter(name => functions[name].bindings.some((b: any) => b.type === 'entityTrigger'));
    const entities = await getFunctionsAndTheirCodesAsync(entityNames, projectKind, projectFolder, hostJsonFolder);

    const otherFunctionNames = functionNames.filter(name => !functions[name].bindings.some((b: any) => ['orchestrationTrigger', 'activityTrigger', 'entityTrigger'].includes(b.type)));
    const otherFunctions = await getFunctionsAndTheirCodesAsync(otherFunctionNames, projectKind, projectFolder, hostJsonFolder);

    for (const orch of orchestrators) {

        // Trying to match this orchestrator with its calling function
        const regex = TraversalRegexes.getStartNewOrchestrationRegex(orch.name);
        for (const func of otherFunctions) {

            // If this function seems to be calling that orchestrator
            if (!!regex.exec(func.code)) {
                functions[orch.name].isCalledBy.push(func.name);
            }
        }

        // Matching suborchestrators
        for (const subOrch of orchestrators) {
            if (orch.name === subOrch.name) {
                continue;
            }

            // If this orchestrator seems to be calling that suborchestrator
            const regex = TraversalRegexes.getCallSubOrchestratorRegex(subOrch.name);
            if (!!regex.exec(orch.code)) {

                // Mapping that suborchestrator to this orchestrator
                functions[subOrch.name].isCalledBy.push(orch.name);
            }
        }

        // Mapping activities to orchestrators
        mapActivitiesToOrchestrator(functions, orch, activityNames);

        // Checking whether orchestrator calls itself
        if (!!TraversalRegexes.continueAsNewRegex.exec(orch.code)) {
            functions[orch.name].isCalledByItself = true;
        }

        // Trying to map event producers with their consumers
        const eventNames = getEventNames(orch.code);
        for (const eventName of eventNames) {
            
            const regex = TraversalRegexes.getRaiseEventRegex(eventName);
            for (const func of otherFunctions) {

                // If this function seems to be sending that event
                if (!!regex.exec(func.code)) {
                    functions[orch.name].isSignalledBy.push({ name: func.name, signalName: eventName });
                }
            }
        }
    }

    for (const entity of entities) {

        // Trying to match this entity with its calling function
        for (const func of otherFunctions) {

            // If this function seems to be calling that entity
            const regex = TraversalRegexes.getSignalEntityRegex(entity.name);
            if (!!regex.exec(func.code)) {
                functions[entity.name].isCalledBy.push(func.name);
            }
        }
    }

    if (projectKind === 'dotNet') {
        
        // Trying to extract extra binding info from C# code
        for (const func of activities.concat(otherFunctions)) {

            const bindingsFromFunctionJson = functions[func.name].bindings as { type: string, direction: string }[];
            const bindingsFromCode = BindingsParser.tryExtractBindings(func.code);

            const existingBindingTypes: string[] = bindingsFromFunctionJson.map(b => b.type);

            for (let binding of bindingsFromCode) {

                // Only pushing extracted binding, if a binding with that type doesn't exist yet in function.json,
                // so that no duplicates are produced
                if (!existingBindingTypes.includes(binding.type)) {
                 
                    bindingsFromFunctionJson.push(binding);
                }
            }

            // Also setting default direction
            for (let binding of bindingsFromFunctionJson) {
                
                if (!binding.direction) {

                    const bindingsOfThisTypeFromCode = bindingsFromCode.filter(b => b.type === binding.type);
                    // If we were able to unambiguosly detect the binding of this type
                    if (bindingsOfThisTypeFromCode.length === 1) {
                        
                        binding.direction = bindingsOfThisTypeFromCode[0].direction;
                    }
                }
            }
        }
    }

    // Also adding file paths and code positions
    for (const func of otherFunctions.concat(orchestrators).concat(activities).concat(entities)) {
        functions[func.name].filePath = func.filePath;
        functions[func.name].pos = func.pos;
        functions[func.name].lineNr = func.lineNr;
    }

    return functions;
}

// Tries to extract event names that this orchestrator is awaiting
function getEventNames(orchestratorCode: string): string[] {

    const result = [];

    const regex = TraversalRegexes.waitForExternalEventRegex;
    var match: RegExpExecArray | null;
    while (!!(match = regex.exec(orchestratorCode))) {
        result.push(match[4]);
    }

    return result;
}

// Tries to load code for functions of certain type
async function getFunctionsAndTheirCodesAsync(functionNames: string[], projectKind: 'dotNet' | 'java' | 'other', projectFolder: string, hostJsonFolder: string)
    : Promise<{ name: string, code: string, filePath: string, pos: number, lineNr: number }[]> {
    
    const promises = functionNames.map(async name => {

        let match;

        switch (projectKind) {
            case 'dotNet':
                match = await findFileRecursivelyAsync(projectFolder, '.+\\.(f|c)s$', true, TraversalRegexes.getDotNetFunctionNameRegex(name));
                break;
            case 'java':
                match = await findFileRecursivelyAsync(projectFolder, '.+\\.java$', true, TraversalRegexes.getDotNetFunctionNameRegex(name));
                break;
            default:
                match = await findFileRecursivelyAsync(path.join(hostJsonFolder, name), '(index\\.ts|index\\.js|__init__\\.py)$', true);
        }
        
        if (!match) {
            return undefined;
        }

        const code = projectKind === 'other' ? match.code : getCodeInBrackets(match.code!, match.pos! + match.length!, '{', '}', ' \n').code;
        const pos = !match.pos ? 0 : match.pos;
        const lineNr = posToLineNr(match.code, pos);

        return { name, code, filePath: match.filePath, pos, lineNr };
    });

    return (await Promise.all(promises)).filter(f => !!f) as any;
}

// Tries to match orchestrator with its activities
function mapActivitiesToOrchestrator(functions: FunctionsMap, orch: {name: string, code: string}, activityNames: string[]): void {

    for (const activityName of activityNames) {

        // If this orchestrator seems to be calling this activity
        const regex = TraversalRegexes.getCallActivityRegex(activityName);
        if (!!regex.exec(orch.code)) {

            // Then mapping this activity to this orchestrator
            if (!functions[activityName].isCalledBy) {
                functions[activityName].isCalledBy = [];
            }
            functions[activityName].isCalledBy.push(orch.name);
        }
    }
}
