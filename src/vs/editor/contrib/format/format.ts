/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { alert } from 'vs/base/browser/ui/aria/aria';
import { isNonEmptyArray } from 'vs/base/common/arrays';
import { first } from 'vs/base/common/async';
import { CancellationToken } from 'vs/base/common/cancellation';
import { illegalArgument, onUnexpectedExternalError } from 'vs/base/common/errors';
import { URI } from 'vs/base/common/uri';
import { CodeEditorStateFlag, EditorState } from 'vs/editor/browser/core/editorState';
import { IActiveCodeEditor, isCodeEditor } from 'vs/editor/browser/editorBrowser';
import { registerLanguageCommand, ServicesAccessor } from 'vs/editor/browser/editorExtensions';
import { Position } from 'vs/editor/common/core/position';
import { Range } from 'vs/editor/common/core/range';
import { Selection } from 'vs/editor/common/core/selection';
import * as editorCommon from 'vs/editor/common/editorCommon';
import { ISingleEditOperation, ITextModel } from 'vs/editor/common/model';
import { DocumentFormattingEditProvider, DocumentFormattingEditProviderRegistry, DocumentRangeFormattingEditProvider, DocumentRangeFormattingEditProviderRegistry, FormattingOptions, OnTypeFormattingEditProviderRegistry, TextEdit } from 'vs/editor/common/modes';
import { IEditorWorkerService } from 'vs/editor/common/services/editorWorkerService';
import { IModelService } from 'vs/editor/common/services/modelService';
import { FormattingEdit } from 'vs/editor/contrib/format/formattingEdit';
import * as nls from 'vs/nls';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';

export function alertFormattingEdits(edits: ISingleEditOperation[]): void {

	edits = edits.filter(edit => edit.range);
	if (!edits.length) {
		return;
	}

	let { range } = edits[0];
	for (let i = 1; i < edits.length; i++) {
		range = Range.plusRange(range, edits[i].range);
	}
	const { startLineNumber, endLineNumber } = range;
	if (startLineNumber === endLineNumber) {
		if (edits.length === 1) {
			alert(nls.localize('hint11', "Made 1 formatting edit on line {0}", startLineNumber));
		} else {
			alert(nls.localize('hintn1', "Made {0} formatting edits on line {1}", edits.length, startLineNumber));
		}
	} else {
		if (edits.length === 1) {
			alert(nls.localize('hint1n', "Made 1 formatting edit between lines {0} and {1}", startLineNumber, endLineNumber));
		} else {
			alert(nls.localize('hintnn', "Made {0} formatting edits between lines {1} and {2}", edits.length, startLineNumber, endLineNumber));
		}
	}
}

export async function formatDocumentRangeUntilResult(
	accessor: ServicesAccessor,
	editorOrModel: ITextModel | IActiveCodeEditor,
	range: Range,
	token: CancellationToken
): Promise<boolean> {

	const insta = accessor.get(IInstantiationService);
	const model = isCodeEditor(editorOrModel) ? editorOrModel.getModel() : editorOrModel;
	const providers = DocumentRangeFormattingEditProviderRegistry.ordered(model);

	for (const provider of providers) {
		if (token.isCancellationRequested) {
			return false;
		}
		const didFormat = await insta.invokeFunction(formatDocumentRangeWithProvider, provider, editorOrModel, range, token);
		if (didFormat) {
			return true;
		}
	}
	return false;
}

export async function formatDocumentRangeWithProvider(
	accessor: ServicesAccessor,
	provider: DocumentRangeFormattingEditProvider,
	editorOrModel: ITextModel | IActiveCodeEditor,
	range: Range,
	token: CancellationToken
): Promise<boolean> {
	const workerService = accessor.get(IEditorWorkerService);

	let model: ITextModel;
	let validate: () => boolean;
	if (isCodeEditor(editorOrModel)) {
		model = editorOrModel.getModel();
		const state = new EditorState(editorOrModel, CodeEditorStateFlag.Value | CodeEditorStateFlag.Position);
		validate = () => state.validate(editorOrModel);
	} else {
		model = editorOrModel;
		const versionNow = editorOrModel.getVersionId();
		validate = () => versionNow === editorOrModel.getVersionId();
	}

	const rawEdits = await provider.provideDocumentRangeFormattingEdits(
		model,
		range,
		model.getFormattingOptions(),
		token
	);

	const edits = await workerService.computeMoreMinimalEdits(model.uri, rawEdits);

	if (!validate()) {
		return true;
	}

	if (!edits || edits.length === 0) {
		return false;
	}

	if (isCodeEditor(editorOrModel)) {
		// use editor to apply edits
		FormattingEdit.execute(editorOrModel, edits);
		alertFormattingEdits(edits);
		editorOrModel.pushUndoStop();
		editorOrModel.focus();
		editorOrModel.revealPositionInCenterIfOutsideViewport(editorOrModel.getPosition(), editorCommon.ScrollType.Immediate);

	} else {
		// use model to apply edits
		const [{ range }] = edits;
		const initialSelection = new Selection(range.startLineNumber, range.startColumn, range.endLineNumber, range.endColumn);
		model.pushEditOperations([initialSelection], edits.map(edit => {
			return {
				text: edit.text,
				range: Range.lift(edit.range),
				forceMoveMarkers: true
			};
		}), undoEdits => {
			for (const { range } of undoEdits) {
				if (Range.areIntersectingOrTouching(range, initialSelection)) {
					return [new Selection(range.startLineNumber, range.startColumn, range.endLineNumber, range.endColumn)];
				}
			}
			return null;
		});
	}

	return true;
}

export async function formatDocumentUntilResult(
	accessor: ServicesAccessor,
	editorOrModel: ITextModel | IActiveCodeEditor,
	token: CancellationToken
): Promise<boolean> {

	const insta = accessor.get(IInstantiationService);
	const model = isCodeEditor(editorOrModel) ? editorOrModel.getModel() : editorOrModel;
	const providers = DocumentFormattingEditProviderRegistry.ordered(model);

	for (const provider of providers) {
		if (token.isCancellationRequested) {
			return false;
		}
		const didFormat = await insta.invokeFunction(formatDocumentWithProvider, provider, editorOrModel, token);
		if (didFormat) {
			return true;
		}
	}
	return false;
}

export async function formatDocumentWithProvider(
	accessor: ServicesAccessor,
	provider: DocumentFormattingEditProvider,
	editorOrModel: ITextModel | IActiveCodeEditor,
	token: CancellationToken
): Promise<boolean> {
	const workerService = accessor.get(IEditorWorkerService);

	let model: ITextModel;
	let validate: () => boolean;
	if (isCodeEditor(editorOrModel)) {
		model = editorOrModel.getModel();
		const state = new EditorState(editorOrModel, CodeEditorStateFlag.Value | CodeEditorStateFlag.Position);
		validate = () => state.validate(editorOrModel);
	} else {
		model = editorOrModel;
		const versionNow = editorOrModel.getVersionId();
		validate = () => versionNow === editorOrModel.getVersionId();
	}

	const rawEdits = await provider.provideDocumentFormattingEdits(
		model,
		model.getFormattingOptions(),
		token
	);

	const edits = await workerService.computeMoreMinimalEdits(model.uri, rawEdits);

	if (!validate()) {
		return true;
	}

	if (!edits || edits.length === 0) {
		return false;
	}

	if (isCodeEditor(editorOrModel)) {
		// use editor to apply edits
		FormattingEdit.execute(editorOrModel, edits);
		alertFormattingEdits(edits);
		editorOrModel.pushUndoStop();
		editorOrModel.focus();
		editorOrModel.revealPositionInCenterIfOutsideViewport(editorOrModel.getPosition(), editorCommon.ScrollType.Immediate);

	} else {
		// use model to apply edits
		const [{ range }] = edits;
		const initialSelection = new Selection(range.startLineNumber, range.startColumn, range.endLineNumber, range.endColumn);
		model.pushEditOperations([initialSelection], edits.map(edit => {
			return {
				text: edit.text,
				range: Range.lift(edit.range),
				forceMoveMarkers: true
			};
		}), undoEdits => {
			for (const { range } of undoEdits) {
				if (Range.areIntersectingOrTouching(range, initialSelection)) {
					return [new Selection(range.startLineNumber, range.startColumn, range.endLineNumber, range.endColumn)];
				}
			}
			return null;
		});
	}

	return true;
}

export async function getDocumentRangeFormattingEditsUntilResult(
	workerService: IEditorWorkerService,
	model: ITextModel,
	range: Range,
	options: FormattingOptions,
	token: CancellationToken
): Promise<TextEdit[] | undefined | null> {

	const providers = DocumentRangeFormattingEditProviderRegistry.ordered(model);
	return first(providers.map(provider => () => {
		return Promise.resolve(provider.provideDocumentRangeFormattingEdits(model, range, options, token)).catch(onUnexpectedExternalError);
	}), isNonEmptyArray).then(edits => {
		// break edits into smaller edits
		return workerService.computeMoreMinimalEdits(model.uri, edits);
	});
}

export async function getDocumentFormattingEditsUntilResult(
	workerService: IEditorWorkerService,
	model: ITextModel,
	options: FormattingOptions,
	token: CancellationToken
): Promise<TextEdit[] | null | undefined> {

	// (1) try document formatter - if available, if successfull
	const providers = DocumentFormattingEditProviderRegistry.ordered(model);
	for (const provider of providers) {
		let rawEdits = await Promise.resolve(provider.provideDocumentFormattingEdits(model, options, token)).catch(onUnexpectedExternalError);
		if (rawEdits) {
			return await workerService.computeMoreMinimalEdits(model.uri, rawEdits);
		}
	}

	// (2) try range formatters when no document formatter is registered
	return getDocumentRangeFormattingEditsUntilResult(
		workerService,
		model,
		model.getFullModelRange(),
		options,
		token
	);
}

export function getOnTypeFormattingEdits(
	workerService: IEditorWorkerService,
	model: ITextModel,
	position: Position,
	ch: string,
	options: FormattingOptions
): Promise<TextEdit[] | null | undefined> {

	const providers = OnTypeFormattingEditProviderRegistry.ordered(model);

	if (providers.length === 0) {
		return Promise.resolve(undefined);
	}

	if (providers[0].autoFormatTriggerCharacters.indexOf(ch) < 0) {
		return Promise.resolve(undefined);
	}

	return Promise.resolve(providers[0].provideOnTypeFormattingEdits(model, position, ch, options, CancellationToken.None)).catch(onUnexpectedExternalError).then(edits => {
		return workerService.computeMoreMinimalEdits(model.uri, edits);
	});
}

registerLanguageCommand('_executeFormatRangeProvider', function (accessor, args) {
	const { resource, range, options } = args;
	if (!(resource instanceof URI) || !Range.isIRange(range)) {
		throw illegalArgument();
	}
	const model = accessor.get(IModelService).getModel(resource);
	if (!model) {
		throw illegalArgument('resource');
	}
	return getDocumentRangeFormattingEditsUntilResult(accessor.get(IEditorWorkerService), model, Range.lift(range), options, CancellationToken.None);
});

registerLanguageCommand('_executeFormatDocumentProvider', function (accessor, args) {
	const { resource, options } = args;
	if (!(resource instanceof URI)) {
		throw illegalArgument('resource');
	}
	const model = accessor.get(IModelService).getModel(resource);
	if (!model) {
		throw illegalArgument('resource');
	}

	return getDocumentFormattingEditsUntilResult(accessor.get(IEditorWorkerService), model, options, CancellationToken.None);
});

registerLanguageCommand('_executeFormatOnTypeProvider', function (accessor, args) {
	const { resource, position, ch, options } = args;
	if (!(resource instanceof URI) || !Position.isIPosition(position) || typeof ch !== 'string') {
		throw illegalArgument();
	}
	const model = accessor.get(IModelService).getModel(resource);
	if (!model) {
		throw illegalArgument('resource');
	}

	return getOnTypeFormattingEdits(accessor.get(IEditorWorkerService), model, Position.lift(position), ch, options);
});
