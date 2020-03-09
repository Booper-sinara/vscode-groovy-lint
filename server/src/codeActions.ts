import { CodeAction, CodeActionParams, DiagnosticSeverity, CodeActionKind, TextDocument, Diagnostic } from 'vscode-languageserver';
import { isNullOrUndefined } from "util";
import { DocumentsManager } from './DocumentsManager';
import { applyTextDocumentEditOnWorkspace } from './clientUtils';
import { parseLinterResultsIntoDiagnostics } from './linter';
const debug = require("debug")("vscode-groovy-lint");

const lintAgainAfterQuickFix = true;

/**
 * Provide quickfixes for a piece of code  *
 * @export
 * @param {TextDocument} textDocument
 * @param {CodeActionParams} parms
 * @returns {CodeAction[]}
 */
export function provideQuickFixCodeActions(textDocument: TextDocument, codeActionParams: CodeActionParams, docQuickFixes: any): CodeAction[] {
	const diagnostics = codeActionParams.context.diagnostics;
	if (isNullOrUndefined(diagnostics) || diagnostics.length === 0) {
		return [];
	}
	const quickFixCodeActions: CodeAction[] = [];
	for (const diagnostic of codeActionParams.context.diagnostics) {
		// Get corresponding QuickFix if existing and convert it as QuickAction
		const diagCode: string = diagnostic.code + '';
		if (docQuickFixes && docQuickFixes[diagCode]) {
			for (const quickFix of docQuickFixes[diagCode]) {
				const codeActions = createQuickFixCodeActions(diagnostic, quickFix, textDocument.uri);
				quickFixCodeActions.push(...codeActions);
			}
		}
		// Add @SuppressWarnings('ErrorCode') for this error
		const suppressWarningActions = createQuickFixSuppressWarningActions(diagnostic, textDocument.uri);
		quickFixCodeActions.push(...suppressWarningActions);
	}
	debug(`Provided ${quickFixCodeActions.length} codeActions for ${textDocument.uri}`);
	return quickFixCodeActions;

}

function createQuickFixCodeActions(diagnostic: Diagnostic, quickFix: any, textDocumentUri: string): CodeAction[] {
	const codeActions: CodeAction[] = [];

	// Quick fix only this error
	const quickFixAction: CodeAction = {
		title: quickFix.label,
		kind: CodeActionKind.QuickFix,
		command: {
			command: 'groovyLint.quickFix',
			title: quickFix.label,
			arguments: [diagnostic, textDocumentUri]
		},
		diagnostics: [diagnostic],
		isPreferred: true
	};
	codeActions.push(quickFixAction);

	// Quick fix error in file
	const quickFixActionAllFile: CodeAction = {
		title: quickFix.label + ' in file',
		kind: CodeActionKind.QuickFix,
		command: {
			command: 'groovyLint.quickFixFile',
			title: quickFix.label + ' in file',
			arguments: [diagnostic, textDocumentUri]
		},
		diagnostics: [diagnostic],
		isPreferred: true
	};
	codeActions.push(quickFixActionAllFile);

	return codeActions;
}

function createQuickFixSuppressWarningActions(diagnostic: Diagnostic, textDocumentUri: string) {
	const suppressWarningActions: CodeAction[] = [];
	let errorLabel = (diagnostic.code as string).split('-')[0].replace(/([A-Z])/g, ' $1').trim();

	if (diagnostic.severity === DiagnosticSeverity.Warning ||
		diagnostic.severity === DiagnosticSeverity.Error ||
		diagnostic.severity === DiagnosticSeverity.Information) {


		// Ignore only this error
		const suppressWarningAction: CodeAction = {
			title: `Ignore ${errorLabel}`,
			kind: CodeActionKind.QuickFix,
			command: {
				command: 'groovyLint.addSuppressWarning',
				title: `Ignore ${errorLabel}`,
				arguments: [diagnostic, textDocumentUri]
			},
			diagnostics: [diagnostic],
			isPreferred: false
		};
		suppressWarningActions.push(suppressWarningAction);

		// ignore this error type in all file
		const suppressWarningFileAction: CodeAction = {
			title: `Ignore ${errorLabel} in file`,
			kind: CodeActionKind.QuickFix,
			command: {
				command: 'groovyLint.addSuppressWarningFile',
				title: `Ignore ${errorLabel} in file`,
				arguments: [diagnostic, textDocumentUri]
			},
			diagnostics: [diagnostic],
			isPreferred: false
		};
		suppressWarningActions.push(suppressWarningFileAction);

		// ignore this error type in all file
		const suppressWarningAlwaysAction: CodeAction = {
			title: `Ignore ${errorLabel} for all files`,
			kind: CodeActionKind.QuickFix,
			command: {
				command: 'groovyLint.alwaysIgnoreError',
				title: `Ignore ${errorLabel} for all files`,
				arguments: [diagnostic, textDocumentUri]
			},
			diagnostics: [diagnostic],
			isPreferred: false
		};
		suppressWarningActions.push(suppressWarningAlwaysAction);
	}
	return suppressWarningActions;
}

// Apply quick fixes
export async function applyQuickFixes(diagnostics: Diagnostic[], textDocumentUri: string, docManager: DocumentsManager) {
	const textDocument: TextDocument = docManager.getDocumentFromUri(textDocumentUri);
	const errorIds: number[] = [];
	for (const diagnostic of diagnostics) {
		errorIds.push(parseInt((diagnostic.code as string).split('-')[1], 10));
	}
	debug(`Request apply QuickFixes for ${textDocumentUri}: ${errorIds.join(',')}`);
	const docLinter = docManager.getDocLinter(textDocument.uri);
	await docLinter.fixErrors(errorIds);
	if (docLinter.status === 0) {
		await applyTextDocumentEditOnWorkspace(docManager, textDocument, docLinter.lintResult.files[0].updatedSource);
		if (lintAgainAfterQuickFix === true) {
			await docManager.validateTextDocument(textDocument);
		} {
			// NV: Faster but experimental... does not work that much so let's lint again after a fix
			const diagnostics: Diagnostic[] = parseLinterResultsIntoDiagnostics(docLinter.lintResult,
				docLinter.lintResult.files[0].updatedSource, textDocument, docManager);
			// Send diagnostics to client
			await docManager.updateDiagnostics(textDocument.uri, diagnostics);
		}
	}
}

// Quick fix in the whole file
export async function applyQuickFixesInFile(diagnostics: Diagnostic[], textDocumentUri: string, docManager: DocumentsManager) {
	const textDocument: TextDocument = docManager.getDocumentFromUri(textDocumentUri);
	const fixRules = (diagnostics[0].code as string).split('-')[0];
	debug(`Request apply QuickFixes in file for all ${fixRules} error in ${textDocumentUri}`);
	await docManager.validateTextDocument(textDocument, { fix: true, fixrules: fixRules });

}

// Add suppress warning
export async function addSuppressWarning(diagnostic: Diagnostic, textDocumentUri: string, scope: string, docManager: DocumentsManager) {
	const textDocument: TextDocument = docManager.getDocumentFromUri(textDocumentUri);
	const allLines = docManager.getTextDocumentLines(textDocument);
	// Get line to check or create
	let linePos: number = 0;
	let removeAll = false;
	switch (scope) {
		case 'line': linePos = (diagnostic?.range?.start?.line) || 0; break;
		case 'file': linePos = 0; removeAll = true; break;
	}
	const line: string = allLines[linePos];
	const prevLine: string = allLines[(linePos === 0) ? 0 : linePos - 1] || '';
	const indent = " ".repeat(line.search(/\S/));
	const errorCode = (diagnostic.code as string).split('-')[0];
	// Create updated @SuppressWarnings line
	if (prevLine.includes('@SuppressWarnings')) {
		const alreadyExistingWarnings = prevLine.trimLeft().replace('@SuppressWarnings', '')
			.replace('(', '').replace(')', '')
			.replace('[', '').replace(']', '')
			.replace(/'/g, '').split(',');
		alreadyExistingWarnings.push(errorCode);
		alreadyExistingWarnings.sort();
		const suppressWarningLine = indent + `@SuppressWarnings(['${[...new Set(alreadyExistingWarnings)].join("','")}'])`;
		await applyTextDocumentEditOnWorkspace(docManager, textDocument, suppressWarningLine, { replaceLinePos: (linePos === 0) ? 0 : linePos - 1 });
		docManager.removeDiagnostics([diagnostic], textDocument.uri, removeAll);
	}
	else {
		// Add new @SuppressWarnings line
		const suppressWarningLine = indent + `@SuppressWarnings(['${errorCode}'])`;
		await applyTextDocumentEditOnWorkspace(docManager, textDocument, suppressWarningLine, { insertLinePos: linePos });
		docManager.removeDiagnostics([diagnostic], textDocument.uri, removeAll, linePos);
	}
}