import * as ts from "typescript";
import * as path from "path";
import {readFileSync} from "fs";
import {IStructure, Class, Interface, Property, Context, Enum} from "./types";

let currentStructure: IStructure;
let currentProperty: Property;

let globalContext: Context;

function defineProperty(property: Property, initializer: any) {
    if (ts.isIdentifier(initializer)) {
        property.type = "ref";
        property.childType = initializer.text;

    } else if (initializer.kind == ts.SyntaxKind.ObjectLiteralExpression) {
        property.type = initializer.properties[0].name.text;
        property.childType = initializer.properties[0].initializer.text;

    } else if (initializer.kind == ts.SyntaxKind.ArrayLiteralExpression) {
        property.type = "array";
        property.childType = initializer.elements[0].text;

    } else {
        property.type = initializer.text;
    }
}

function inspectNode(node: ts.Node, context: Context, decoratorName: string) {
    switch (node.kind) {
        case ts.SyntaxKind.ImportClause:
            const specifier = (node.parent as any).moduleSpecifier;
            if (specifier && (specifier.text as string).startsWith('.')) {
                const currentDir = path.dirname(node.getSourceFile().fileName);
                const pathToImport = path.resolve(currentDir, specifier.text);
                parseFiles([pathToImport], decoratorName, globalContext);
            }
            break;

        case ts.SyntaxKind.ClassDeclaration:
            currentStructure = new Class();

            const heritageClauses = (node as ts.ClassLikeDeclarationBase).heritageClauses;
            if (heritageClauses && heritageClauses.length > 0) {
                (currentStructure as Class).extends = heritageClauses[0].types[0].expression.getText();
            }

            context.addStructure(currentStructure);
            break;

        case ts.SyntaxKind.InterfaceDeclaration:
            //
            // Only generate Interfaces if it has "Message" on its name.
            // Example: MyMessage
            //
            const interfaceName = (node as ts.TypeParameterDeclaration).name.escapedText.toString();
            if (interfaceName.indexOf("Message") !== -1) {
                currentStructure = new Interface();
                currentStructure.name = interfaceName;

                context.addStructure(currentStructure);
            }
            break;

        case ts.SyntaxKind.EnumDeclaration:
            const enumName = (
                node as ts.EnumDeclaration
            ).name.escapedText.toString();
            currentStructure = new Enum();
            currentStructure.name = enumName;
            context.addStructure(currentStructure);
            break;

        case ts.SyntaxKind.ExtendsKeyword:
            // console.log(node.getText());
            break;

        case ts.SyntaxKind.PropertySignature:
            if (currentStructure instanceof Interface) {
                const interfaceDeclaration = node.parent;

                if (
                    currentStructure.name !== (interfaceDeclaration as ts.TypeParameterDeclaration).name.escapedText.toString()
                ) {
                    // skip if property if for a another interface than the one we're interested in.
                    break;
                }

                // define a property of an interface
                const property = new Property();
                property.name = (node as any).name.escapedText.toString();
                property.type = (node as any).type.getText();
                currentStructure.addProperty(property);
            }
            break;

        case ts.SyntaxKind.Identifier:
            if (
                node.getText() === "deprecated" &&
                node.parent.kind !== ts.SyntaxKind.ImportSpecifier
            ) {
                currentProperty = new Property();
                currentProperty.deprecated = true;
                break;
            }

            if (node.getText() === decoratorName) {
                const prop: any = node.parent?.parent?.parent;
                const propDecorator = getDecorators(prop);
                const hasExpression = prop?.expression?.arguments;
                const hasDecorator = (propDecorator?.length > 0);

                /**
                 * neither a `@type()` decorator or `type()` call. skip.
                 */
                if (!hasDecorator && !hasExpression) {
                    break;
                }

                // using as decorator
                if (propDecorator) {
                    /**
                     * Calling `@type()` as decorator
                     */
                    const typeDecorator: any = propDecorator.find((decorator => {
                        return (decorator.expression as any).expression.escapedText === decoratorName;
                    }));
                    if (!typeDecorator) {
                        break;
                    }
                    const typeExpression = typeDecorator.expression;

                    const property = currentProperty || new Property();
                    property.name = prop.name.escapedText;
                    currentStructure.addProperty(property);

                    const typeArgument = typeExpression.arguments[0];
                    defineProperty(property, typeArgument);

                    const typeName = prop.type && prop.type.typeName && prop.type.typeName.escapedText;
                    if (typeName && typeName.endsWith('Enum')) {
                        property.enumType = typeName;
                    }

                } else if (
                    prop.expression.arguments?.[1] &&
                    prop.expression.expression.arguments?.[0]
                ) {
                    /**
                     * Calling `type()` as a regular method
                     */
                    const property = currentProperty || new Property();
                    property.name = prop.expression.arguments[1].text;
                    currentStructure.addProperty(property);

                    const typeArgument = prop.expression.expression.arguments[0];
                    defineProperty(property, typeArgument);
                }

            } else if (
                node.getText() === "setFields" &&
                (
                    node.parent.kind === ts.SyntaxKind.CallExpression ||
                    node.parent.kind === ts.SyntaxKind.PropertyAccessExpression
                )
            ) {
                /**
                 * Metadata.setFields(klassName, { ... })
                 */
                const callExpression = (node.parent.kind === ts.SyntaxKind.PropertyAccessExpression)
                    ? node.parent.parent as ts.CallExpression
                    : node.parent as ts.CallExpression;

                if (callExpression.kind !== ts.SyntaxKind.CallExpression) {
                    break;
                }

                const classNameNode = callExpression.arguments[0];
                const className = ts.isClassExpression(classNameNode)
                    ? classNameNode.name?.escapedText.toString()
                    : classNameNode.getText();

                // skip if no className is provided
                if (!className) { break; }

                if (currentStructure.name !== className) {
                    currentStructure = new Class();
                }
                context.addStructure(currentStructure);
                (currentStructure as Class).extends = "Schema"; // force extends to Schema
                currentStructure.name = className;

                const types = callExpression.arguments[1] as any;
                for (let i = 0; i < types.properties.length; i++) {
                    const prop = types.properties[i];

                    const property = currentProperty || new Property();
                    property.name = prop.name.escapedText;

                    currentStructure.addProperty(property);
                    defineProperty(property, prop.initializer);
                }

            } else if (
                node.getText() === "defineTypes" &&
                (
                    node.parent.kind === ts.SyntaxKind.CallExpression ||
                    node.parent.kind === ts.SyntaxKind.PropertyAccessExpression
                )
            ) {
                /**
                 * JavaScript source file (`.js`)
                 * Using `defineTypes()`
                 */
                const callExpression = (node.parent.kind === ts.SyntaxKind.PropertyAccessExpression)
                    ? node.parent.parent as ts.CallExpression
                    : node.parent as ts.CallExpression;

                if (callExpression.kind !== ts.SyntaxKind.CallExpression) {
                    break;
                }

                const className = callExpression.arguments[0].getText()
                currentStructure.name = className;

                const types = callExpression.arguments[1] as any;
                for (let i = 0; i < types.properties.length; i++) {
                    const prop = types.properties[i];

                    const property = currentProperty || new Property();
                    property.name = prop.name.escapedText;
                    currentStructure.addProperty(property);

                    defineProperty(property, prop.initializer);
                }

            }

            if (node.parent.kind === ts.SyntaxKind.ClassDeclaration) {
                currentStructure.name = node.getText();
            }

            currentProperty = undefined;

            break;

        case ts.SyntaxKind.CallExpression:
            /**
             * Defining schema via `schema.schema({ ... })`
             * - schema.schema({})
             * - schema({})
             * - ClassName.extends({})
             */
            if (
                (
                    (
                        (node as ts.CallExpression).expression?.getText() === "schema.schema" ||
                        (node as ts.CallExpression).expression?.getText() === "schema"
                    ) ||
                    (
                        (node as ts.CallExpression).expression?.getText().indexOf(".extends") !== -1
                    )
                ) &&
                (node as ts.CallExpression).arguments[0].kind === ts.SyntaxKind.ObjectLiteralExpression
            ) {
                const callExpression = node as ts.CallExpression;

                let className = callExpression.arguments[1]?.getText();

                if (!className && callExpression.parent.kind === ts.SyntaxKind.VariableDeclaration) {
                    className = (callExpression.parent as ts.VariableDeclaration).name?.getText();
                }

                // skip if no className is provided
                if (!className) { break; }

                if (currentStructure.name !== className) {
                    currentStructure = new Class();
                    context.addStructure(currentStructure);
                }

                if ((node as ts.CallExpression).expression?.getText().indexOf(".extends") !== -1) {
                    // if it's using `.extends({})`
                    const extendsClass = (node as any).expression?.expression?.escapedText;

                    // skip if no extendsClass is provided
                    if (!extendsClass) { break; }
                    (currentStructure as Class).extends = extendsClass;

                } else {
                    // if it's using `schema({})`
                    (currentStructure as Class).extends = "Schema"; // force extends to Schema
                }

                currentStructure.name = className;

                const types = callExpression.arguments[0] as any;
                for (let i = 0; i < types.properties.length; i++) {
                    const prop = types.properties[i];

                    const property = currentProperty || new Property();
                    property.name = prop.name.escapedText;

                    currentStructure.addProperty(property);
                    defineProperty(property, prop.initializer);
                }
            }

            break;

        case ts.SyntaxKind.EnumMember:
            if (currentStructure instanceof Enum) {
                const initializer = (node as any).initializer?.text;
                const name = node.getFirstToken().getText();
                const property = currentProperty || new Property();
                property.name = name;
                if (initializer !== undefined) {
                    property.type = initializer;
                }
                currentStructure.addProperty(property);
                currentProperty = undefined;
            }
            break;
    }

    ts.forEachChild(node, (n) => inspectNode(n, context, decoratorName));
}

let parsedFiles: { [filename: string]: boolean };

export function parseFiles(
    fileNames: string[],
    decoratorName: string = "type",
    context: Context = new Context()
) {
    /**
     * Re-set globalContext for each test case
     */
    if (globalContext !== context) {
        parsedFiles = {};
        globalContext = context;
    }

    fileNames.forEach((fileName) => {
        let sourceFile: ts.Node;
        let sourceFileName: string;

        const fileNameAlternatives = [];

        if (
            !fileName.endsWith(".ts") &&
            !fileName.endsWith(".js") &&
            !fileName.endsWith(".mjs")
        ) {
            fileNameAlternatives.push(`${fileName}.ts`);
            fileNameAlternatives.push(`${fileName}/index.ts`);

        } else {
            fileNameAlternatives.push(fileName);
        }

        for (let i = 0; i < fileNameAlternatives.length; i++) {
            try {
                sourceFileName = path.resolve(fileNameAlternatives[i]);

                if (parsedFiles[sourceFileName]) {
                    break;
                }

                sourceFile = ts.createSourceFile(
                    sourceFileName,
                    readFileSync(sourceFileName).toString(),
                    ts.ScriptTarget.Latest,
                    true
                );

                parsedFiles[sourceFileName] = true;

                break;
            } catch (e) {
                // console.log(`${fileNameAlternatives[i]} => ${e.message}`);
            }
        }

        if (sourceFile) {
            inspectNode(sourceFile, context, decoratorName);
        }
    });

    return context.getStructures();
}

/**
 * TypeScript 4.8+ has introduced a change on how to access decorators.
 * - https://github.com/microsoft/TypeScript/pull/49089
 * - https://devblogs.microsoft.com/typescript/announcing-typescript-4-8/#decorators-are-placed-on-modifiers-on-typescripts-syntax-trees
 */
export function getDecorators(node: ts.Node | null | undefined,): undefined | ts.Decorator[] {
    if (node == undefined) { return undefined; }

    // TypeScript 4.7 and below
    // @ts-ignore
    if (node.decorators) { return node.decorators; }

    // TypeScript 4.8 and above
    // @ts-ignore
    if (ts.canHaveDecorators && ts.canHaveDecorators(node)) {
        // @ts-ignore
        const decorators = ts.getDecorators(node);
        return decorators ? Array.from(decorators) : undefined;
    }

    // @ts-ignore
    return node.modifiers?.filter(ts.isDecorator);
}
