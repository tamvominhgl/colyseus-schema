import {
    Class,
    Property,
    File,
    getCommentHeader,
    Interface,
    Enum,
} from "../types";
import { GenerateOptions } from "../api";
import { Context } from "../types";

const typeMaps = {
    "string": "string",
    "number": "float",
    "boolean": "bool",
    "int8": "sbyte",
    "uint8": "byte",
    "int16": "short",
    "uint16": "ushort",
    "int32": "int",
    "uint32": "uint",
    "int64": "long",
    "uint64": "ulong",
    "float32": "float",
    "float64": "double",
}

/**
 * C# Code Generator
 */
const capitalize = (s) => {
    if (typeof s !== 'string') return ''
    return s.charAt(0).toUpperCase() + s.slice(1);
}

export function generate(context: Context, options: GenerateOptions): File[] {
    // enrich typeMaps with enums
    context.enums.forEach((structure) => {
        typeMaps[structure.name] = structure.name;
    });
    return [
        ...context.classes.map(structure => ({
            name: `${structure.name}.cs`,
            content: generateClass(structure, options.namespace)
        })),
        ...context.interfaces.map(structure => ({
            name: `${structure.name}.cs`,
            content: generateInterface(structure, options.namespace, options.using),
        })),
        ...context.enums.filter(structure => structure.name !== 'OPERATION').map((structure) => ({
            name: `${structure.name}.cs`,
            content: generateEnum(structure, options.namespace),
        })),
    ];
}

function generateClass(klass: Class, namespace: string) {
    const indent = (namespace) ? "\t" : "";
    return `${getCommentHeader()}

using Colyseus.Schema;
using UnityEngine.Scripting;
${namespace ? `\nnamespace ${namespace} {` : ""}
${indent}public partial class ${klass.name} : ${klass.extends} {
${indent}\t[Preserve]
${indent}\tpublic ${klass.name}() { }

${klass.properties.map((prop) => generateProperty(prop, indent)).join("\n\n")}
${indent}}
${namespace ? "}" : ""}
`;
}

function generateEnum(_enum: Enum, namespace: string) {
    const indent = namespace ? "\t" : "";
    if (_enum.name.endsWith('Enum')) {
    return `${getCommentHeader()}
${namespace ? `\nnamespace ${namespace} {` : ""}
${indent}public enum ${_enum.name} : int {

${_enum.properties
    .map((prop) => {
        let dataType: string = "int";
        let value: any;

        if(prop.type) {
            if(isNaN(Number(prop.type))) {
                value = `"${prop.type}"`;
                dataType = "string";
            } else {
                value = Number(prop.type);
                dataType = Number.isInteger(value)? 'int': 'float';
            }
        } else {
            value = _enum.properties.indexOf(prop);
        }
        return `${indent}\t${prop.name} = ${value},`;
    })
        .join("\n")}
${indent}}
${namespace ? "}" : ""}`
    }

    return `${getCommentHeader()}
${namespace ? `\nnamespace ${namespace} {` : ""}
${indent}public struct ${_enum.name} {

${_enum.properties
    .map((prop) => {
        let dataType: string = "int";
        let value: any;

        if(prop.type) {
            if(isNaN(Number(prop.type))) {
                value = `"${prop.type}"`;
                dataType = "string";
            } else {
                value = Number(prop.type);
                dataType = Number.isInteger(value)? 'int': 'float';
            }
        } else {
            value = _enum.properties.indexOf(prop);
        }
        return `${indent}\tpublic const ${dataType} ${prop.name} = ${value};`;
    })
        .join("\n")}
${indent}}
${namespace ? "}" : ""}`
}

function generateProperty(prop: Property, indent: string = "") {
    let typeArgs = `"${prop.type}"`;
    let property = "public";
    let langType: string;
    let initializer = "";

    if (prop.childType) {
        const isUpcaseFirst = prop.childType.match(/^[A-Z]/);

        langType = getType(prop);
        typeArgs += `, typeof(${langType})`;

        if (!isUpcaseFirst) {
            typeArgs += `, "${prop.childType}"`;
        }

        initializer = `new()`;

    } else {
        langType = getType(prop);
        initializer = `default`;
    }

    property += ` ${langType} ${prop.name}`;

    let ret = (prop.deprecated) ? `\t\t[System.Obsolete("field '${prop.name}' is deprecated.", true)]\n` : '';

    return ret + `\t${indent}[Type(${prop.index}, ${typeArgs})]
\t${indent}${property} = ${initializer};`;
}

function generateInterface(struct: Interface, namespace: string, using: string) {
    const indent = (namespace) ? "\t" : "";
    return `${getCommentHeader()}

using MessagePack;
${using ? `using ${using};` : ""}
${namespace ? `\nnamespace ${namespace} {` : ""}
${indent}[MessagePackObject(keyAsPropertyName: true)]
${indent}public class ${struct.name} {
${struct.properties.map(prop => `\t${indent}public ${getTypeForInterface(prop)} ${prop.name};`).join("\n")}
${indent}}
${namespace ? "}" : ""}
`;
}

function getTypeForInterface(prop: Property) {
    let langType = getType(prop);

    if (langType.startsWith('ArraySchema<')) {
        langType = `${typeMaps[prop.childType] || prop.childType}[]`;
    }

    return langType;
}

function getChildType(prop: Property) {
    return typeMaps[prop.childType];
}

function getType(prop: Property) {
    if (prop.enumType) {
        return prop.enumType;
    } else if (prop.childType) {
        const isUpcaseFirst = prop.childType.match(/^[A-Z]/);
        let type: string;

        if(prop.type === "ref") {
            type = (isUpcaseFirst)
                ? prop.childType
                : getChildType(prop);
        } else {
            const containerClass = capitalize(prop.type);
            type = (isUpcaseFirst)
                ? `${containerClass}Schema<${prop.childType}>`
                : `${containerClass}Schema<${getChildType(prop)}>`;
        }
        return type;

    } else {
        return (prop.type === "array")
            ? `${typeMaps[prop.childType] || prop.childType}[]`
            : typeMaps[prop.type];
    }
}
