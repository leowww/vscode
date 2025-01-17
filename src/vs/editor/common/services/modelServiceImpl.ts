/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from 'vs/base/common/event';
import { Disposable, IDisposable, DisposableStore } from 'vs/base/common/lifecycle';
import * as platform from 'vs/base/common/platform';
import * as errors from 'vs/base/common/errors';
import { URI } from 'vs/base/common/uri';
import { EDITOR_MODEL_DEFAULTS } from 'vs/editor/common/config/editorOptions';
import { EditOperation } from 'vs/editor/common/core/editOperation';
import { Range } from 'vs/editor/common/core/range';
import { DefaultEndOfLine, EndOfLinePreference, EndOfLineSequence, IIdentifiedSingleEditOperation, ITextBuffer, ITextBufferFactory, ITextModel, ITextModelCreationOptions } from 'vs/editor/common/model';
import { TextModel, createTextBuffer } from 'vs/editor/common/model/textModel';
import { IModelLanguageChangedEvent, IModelContentChangedEvent } from 'vs/editor/common/model/textModelEvents';
import { LanguageIdentifier, SemanticColoringProviderRegistry, SemanticColoringProvider, SemanticColoring, SemanticColoringLegend } from 'vs/editor/common/modes';
import { PLAINTEXT_LANGUAGE_IDENTIFIER } from 'vs/editor/common/modes/modesRegistry';
import { ILanguageSelection } from 'vs/editor/common/services/modeService';
import { IModelService } from 'vs/editor/common/services/modelService';
import { ITextResourcePropertiesService } from 'vs/editor/common/services/resourceConfiguration';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { RunOnceScheduler } from 'vs/base/common/async';
import { CancellationTokenSource } from 'vs/base/common/cancellation';
import { SparseEncodedTokens, MultilineTokens2 } from 'vs/editor/common/model/tokensStore';
import { IThemeService } from 'vs/platform/theme/common/themeService';

function MODEL_ID(resource: URI): string {
	return resource.toString();
}

class ModelData implements IDisposable {
	public readonly model: ITextModel;

	private _languageSelection: ILanguageSelection | null;
	private _languageSelectionListener: IDisposable | null;

	private readonly _modelEventListeners = new DisposableStore();

	constructor(
		model: ITextModel,
		onWillDispose: (model: ITextModel) => void,
		onDidChangeLanguage: (model: ITextModel, e: IModelLanguageChangedEvent) => void
	) {
		this.model = model;

		this._languageSelection = null;
		this._languageSelectionListener = null;

		this._modelEventListeners.add(model.onWillDispose(() => onWillDispose(model)));
		this._modelEventListeners.add(model.onDidChangeLanguage((e) => onDidChangeLanguage(model, e)));
	}

	private _disposeLanguageSelection(): void {
		if (this._languageSelectionListener) {
			this._languageSelectionListener.dispose();
			this._languageSelectionListener = null;
		}
		if (this._languageSelection) {
			this._languageSelection.dispose();
			this._languageSelection = null;
		}
	}

	public dispose(): void {
		this._modelEventListeners.dispose();
		this._disposeLanguageSelection();
	}

	public setLanguage(languageSelection: ILanguageSelection): void {
		this._disposeLanguageSelection();
		this._languageSelection = languageSelection;
		this._languageSelectionListener = this._languageSelection.onDidChange(() => this.model.setMode(languageSelection.languageIdentifier));
		this.model.setMode(languageSelection.languageIdentifier);
	}
}

interface IRawEditorConfig {
	tabSize?: any;
	indentSize?: any;
	insertSpaces?: any;
	detectIndentation?: any;
	trimAutoWhitespace?: any;
	creationOptions?: any;
	largeFileOptimizations?: any;
}

interface IRawConfig {
	eol?: any;
	editor?: IRawEditorConfig;
}

const DEFAULT_EOL = (platform.isLinux || platform.isMacintosh) ? DefaultEndOfLine.LF : DefaultEndOfLine.CRLF;

export class ModelServiceImpl extends Disposable implements IModelService {
	public _serviceBrand: undefined;

	private readonly _configurationService: IConfigurationService;
	private readonly _configurationServiceSubscription: IDisposable;
	private readonly _resourcePropertiesService: ITextResourcePropertiesService;

	private readonly _onModelAdded: Emitter<ITextModel> = this._register(new Emitter<ITextModel>());
	public readonly onModelAdded: Event<ITextModel> = this._onModelAdded.event;

	private readonly _onModelRemoved: Emitter<ITextModel> = this._register(new Emitter<ITextModel>());
	public readonly onModelRemoved: Event<ITextModel> = this._onModelRemoved.event;

	private readonly _onModelModeChanged: Emitter<{ model: ITextModel; oldModeId: string; }> = this._register(new Emitter<{ model: ITextModel; oldModeId: string; }>());
	public readonly onModelModeChanged: Event<{ model: ITextModel; oldModeId: string; }> = this._onModelModeChanged.event;

	private _modelCreationOptionsByLanguageAndResource: {
		[languageAndResource: string]: ITextModelCreationOptions;
	};

	/**
	 * All the models known in the system.
	 */
	private readonly _models: { [modelId: string]: ModelData; };

	constructor(
		@IConfigurationService configurationService: IConfigurationService,
		@ITextResourcePropertiesService resourcePropertiesService: ITextResourcePropertiesService,
		@IThemeService themeService: IThemeService
	) {
		super();
		this._configurationService = configurationService;
		this._resourcePropertiesService = resourcePropertiesService;
		this._models = {};
		this._modelCreationOptionsByLanguageAndResource = Object.create(null);

		this._configurationServiceSubscription = this._configurationService.onDidChangeConfiguration(e => this._updateModelOptions());
		this._updateModelOptions();

		this._register(new SemanticColoringFeature(this, themeService));
	}

	private static _readModelOptions(config: IRawConfig, isForSimpleWidget: boolean): ITextModelCreationOptions {
		let tabSize = EDITOR_MODEL_DEFAULTS.tabSize;
		if (config.editor && typeof config.editor.tabSize !== 'undefined') {
			let parsedTabSize = parseInt(config.editor.tabSize, 10);
			if (!isNaN(parsedTabSize)) {
				tabSize = parsedTabSize;
			}
			if (tabSize < 1) {
				tabSize = 1;
			}
		}

		let indentSize = tabSize;
		if (config.editor && typeof config.editor.indentSize !== 'undefined' && config.editor.indentSize !== 'tabSize') {
			let parsedIndentSize = parseInt(config.editor.indentSize, 10);
			if (!isNaN(parsedIndentSize)) {
				indentSize = parsedIndentSize;
			}
			if (indentSize < 1) {
				indentSize = 1;
			}
		}

		let insertSpaces = EDITOR_MODEL_DEFAULTS.insertSpaces;
		if (config.editor && typeof config.editor.insertSpaces !== 'undefined') {
			insertSpaces = (config.editor.insertSpaces === 'false' ? false : Boolean(config.editor.insertSpaces));
		}

		let newDefaultEOL = DEFAULT_EOL;
		const eol = config.eol;
		if (eol === '\r\n') {
			newDefaultEOL = DefaultEndOfLine.CRLF;
		} else if (eol === '\n') {
			newDefaultEOL = DefaultEndOfLine.LF;
		}

		let trimAutoWhitespace = EDITOR_MODEL_DEFAULTS.trimAutoWhitespace;
		if (config.editor && typeof config.editor.trimAutoWhitespace !== 'undefined') {
			trimAutoWhitespace = (config.editor.trimAutoWhitespace === 'false' ? false : Boolean(config.editor.trimAutoWhitespace));
		}

		let detectIndentation = EDITOR_MODEL_DEFAULTS.detectIndentation;
		if (config.editor && typeof config.editor.detectIndentation !== 'undefined') {
			detectIndentation = (config.editor.detectIndentation === 'false' ? false : Boolean(config.editor.detectIndentation));
		}

		let largeFileOptimizations = EDITOR_MODEL_DEFAULTS.largeFileOptimizations;
		if (config.editor && typeof config.editor.largeFileOptimizations !== 'undefined') {
			largeFileOptimizations = (config.editor.largeFileOptimizations === 'false' ? false : Boolean(config.editor.largeFileOptimizations));
		}

		return {
			isForSimpleWidget: isForSimpleWidget,
			tabSize: tabSize,
			indentSize: indentSize,
			insertSpaces: insertSpaces,
			detectIndentation: detectIndentation,
			defaultEOL: newDefaultEOL,
			trimAutoWhitespace: trimAutoWhitespace,
			largeFileOptimizations: largeFileOptimizations
		};
	}

	public getCreationOptions(language: string, resource: URI | undefined, isForSimpleWidget: boolean): ITextModelCreationOptions {
		let creationOptions = this._modelCreationOptionsByLanguageAndResource[language + resource];
		if (!creationOptions) {
			const editor = this._configurationService.getValue<IRawEditorConfig>('editor', { overrideIdentifier: language, resource });
			const eol = this._resourcePropertiesService.getEOL(resource, language);
			creationOptions = ModelServiceImpl._readModelOptions({ editor, eol }, isForSimpleWidget);
			this._modelCreationOptionsByLanguageAndResource[language + resource] = creationOptions;
		}
		return creationOptions;
	}

	private _updateModelOptions(): void {
		let oldOptionsByLanguageAndResource = this._modelCreationOptionsByLanguageAndResource;
		this._modelCreationOptionsByLanguageAndResource = Object.create(null);

		// Update options on all models
		let keys = Object.keys(this._models);
		for (let i = 0, len = keys.length; i < len; i++) {
			let modelId = keys[i];
			let modelData = this._models[modelId];
			const language = modelData.model.getLanguageIdentifier().language;
			const uri = modelData.model.uri;
			const oldOptions = oldOptionsByLanguageAndResource[language + uri];
			const newOptions = this.getCreationOptions(language, uri, modelData.model.isForSimpleWidget);
			ModelServiceImpl._setModelOptionsForModel(modelData.model, newOptions, oldOptions);
		}
	}

	private static _setModelOptionsForModel(model: ITextModel, newOptions: ITextModelCreationOptions, currentOptions: ITextModelCreationOptions): void {
		if (currentOptions && currentOptions.defaultEOL !== newOptions.defaultEOL && model.getLineCount() === 1) {
			model.setEOL(newOptions.defaultEOL === DefaultEndOfLine.LF ? EndOfLineSequence.LF : EndOfLineSequence.CRLF);
		}

		if (currentOptions
			&& (currentOptions.detectIndentation === newOptions.detectIndentation)
			&& (currentOptions.insertSpaces === newOptions.insertSpaces)
			&& (currentOptions.tabSize === newOptions.tabSize)
			&& (currentOptions.indentSize === newOptions.indentSize)
			&& (currentOptions.trimAutoWhitespace === newOptions.trimAutoWhitespace)
		) {
			// Same indent opts, no need to touch the model
			return;
		}

		if (newOptions.detectIndentation) {
			model.detectIndentation(newOptions.insertSpaces, newOptions.tabSize);
			model.updateOptions({
				trimAutoWhitespace: newOptions.trimAutoWhitespace
			});
		} else {
			model.updateOptions({
				insertSpaces: newOptions.insertSpaces,
				tabSize: newOptions.tabSize,
				indentSize: newOptions.indentSize,
				trimAutoWhitespace: newOptions.trimAutoWhitespace
			});
		}
	}

	public dispose(): void {
		this._configurationServiceSubscription.dispose();
		super.dispose();
	}

	// --- begin IModelService

	private _createModelData(value: string | ITextBufferFactory, languageIdentifier: LanguageIdentifier, resource: URI | undefined, isForSimpleWidget: boolean): ModelData {
		// create & save the model
		const options = this.getCreationOptions(languageIdentifier.language, resource, isForSimpleWidget);
		const model: TextModel = new TextModel(value, options, languageIdentifier, resource);
		const modelId = MODEL_ID(model.uri);

		if (this._models[modelId]) {
			// There already exists a model with this id => this is a programmer error
			throw new Error('ModelService: Cannot add model because it already exists!');
		}

		const modelData = new ModelData(
			model,
			(model) => this._onWillDispose(model),
			(model, e) => this._onDidChangeLanguage(model, e)
		);
		this._models[modelId] = modelData;

		return modelData;
	}

	public updateModel(model: ITextModel, value: string | ITextBufferFactory): void {
		const options = this.getCreationOptions(model.getLanguageIdentifier().language, model.uri, model.isForSimpleWidget);
		const textBuffer = createTextBuffer(value, options.defaultEOL);

		// Return early if the text is already set in that form
		if (model.equalsTextBuffer(textBuffer)) {
			return;
		}

		// Otherwise find a diff between the values and update model
		model.pushStackElement();
		model.pushEOL(textBuffer.getEOL() === '\r\n' ? EndOfLineSequence.CRLF : EndOfLineSequence.LF);
		model.pushEditOperations(
			[],
			ModelServiceImpl._computeEdits(model, textBuffer),
			(inverseEditOperations: IIdentifiedSingleEditOperation[]) => []
		);
		model.pushStackElement();
	}

	private static _commonPrefix(a: ILineSequence, aLen: number, aDelta: number, b: ILineSequence, bLen: number, bDelta: number): number {
		const maxResult = Math.min(aLen, bLen);

		let result = 0;
		for (let i = 0; i < maxResult && a.getLineContent(aDelta + i) === b.getLineContent(bDelta + i); i++) {
			result++;
		}
		return result;
	}

	private static _commonSuffix(a: ILineSequence, aLen: number, aDelta: number, b: ILineSequence, bLen: number, bDelta: number): number {
		const maxResult = Math.min(aLen, bLen);

		let result = 0;
		for (let i = 0; i < maxResult && a.getLineContent(aDelta + aLen - i) === b.getLineContent(bDelta + bLen - i); i++) {
			result++;
		}
		return result;
	}

	/**
	 * Compute edits to bring `model` to the state of `textSource`.
	 */
	public static _computeEdits(model: ITextModel, textBuffer: ITextBuffer): IIdentifiedSingleEditOperation[] {
		const modelLineCount = model.getLineCount();
		const textBufferLineCount = textBuffer.getLineCount();
		const commonPrefix = this._commonPrefix(model, modelLineCount, 1, textBuffer, textBufferLineCount, 1);

		if (modelLineCount === textBufferLineCount && commonPrefix === modelLineCount) {
			// equality case
			return [];
		}

		const commonSuffix = this._commonSuffix(model, modelLineCount - commonPrefix, commonPrefix, textBuffer, textBufferLineCount - commonPrefix, commonPrefix);

		let oldRange: Range, newRange: Range;
		if (commonSuffix > 0) {
			oldRange = new Range(commonPrefix + 1, 1, modelLineCount - commonSuffix + 1, 1);
			newRange = new Range(commonPrefix + 1, 1, textBufferLineCount - commonSuffix + 1, 1);
		} else if (commonPrefix > 0) {
			oldRange = new Range(commonPrefix, model.getLineMaxColumn(commonPrefix), modelLineCount, model.getLineMaxColumn(modelLineCount));
			newRange = new Range(commonPrefix, 1 + textBuffer.getLineLength(commonPrefix), textBufferLineCount, 1 + textBuffer.getLineLength(textBufferLineCount));
		} else {
			oldRange = new Range(1, 1, modelLineCount, model.getLineMaxColumn(modelLineCount));
			newRange = new Range(1, 1, textBufferLineCount, 1 + textBuffer.getLineLength(textBufferLineCount));
		}

		return [EditOperation.replaceMove(oldRange, textBuffer.getValueInRange(newRange, EndOfLinePreference.TextDefined))];
	}

	public createModel(value: string | ITextBufferFactory, languageSelection: ILanguageSelection | null, resource?: URI, isForSimpleWidget: boolean = false): ITextModel {
		let modelData: ModelData;

		if (languageSelection) {
			modelData = this._createModelData(value, languageSelection.languageIdentifier, resource, isForSimpleWidget);
			this.setMode(modelData.model, languageSelection);
		} else {
			modelData = this._createModelData(value, PLAINTEXT_LANGUAGE_IDENTIFIER, resource, isForSimpleWidget);
		}

		this._onModelAdded.fire(modelData.model);

		return modelData.model;
	}

	public setMode(model: ITextModel, languageSelection: ILanguageSelection): void {
		if (!languageSelection) {
			return;
		}
		let modelData = this._models[MODEL_ID(model.uri)];
		if (!modelData) {
			return;
		}
		modelData.setLanguage(languageSelection);
	}

	public destroyModel(resource: URI): void {
		// We need to support that not all models get disposed through this service (i.e. model.dispose() should work!)
		let modelData = this._models[MODEL_ID(resource)];
		if (!modelData) {
			return;
		}
		modelData.model.dispose();
	}

	public getModels(): ITextModel[] {
		let ret: ITextModel[] = [];

		let keys = Object.keys(this._models);
		for (let i = 0, len = keys.length; i < len; i++) {
			let modelId = keys[i];
			ret.push(this._models[modelId].model);
		}

		return ret;
	}

	public getModel(resource: URI): ITextModel | null {
		let modelId = MODEL_ID(resource);
		let modelData = this._models[modelId];
		if (!modelData) {
			return null;
		}
		return modelData.model;
	}

	// --- end IModelService

	private _onWillDispose(model: ITextModel): void {
		let modelId = MODEL_ID(model.uri);
		let modelData = this._models[modelId];

		delete this._models[modelId];
		modelData.dispose();

		// clean up cache
		delete this._modelCreationOptionsByLanguageAndResource[model.getLanguageIdentifier().language + model.uri];

		this._onModelRemoved.fire(model);
	}

	private _onDidChangeLanguage(model: ITextModel, e: IModelLanguageChangedEvent): void {
		const oldModeId = e.oldLanguage;
		const newModeId = model.getLanguageIdentifier().language;
		const oldOptions = this.getCreationOptions(oldModeId, model.uri, model.isForSimpleWidget);
		const newOptions = this.getCreationOptions(newModeId, model.uri, model.isForSimpleWidget);
		ModelServiceImpl._setModelOptionsForModel(model, newOptions, oldOptions);
		this._onModelModeChanged.fire({ model, oldModeId });
	}
}

export interface ILineSequence {
	getLineContent(lineNumber: number): string;
}

class SemanticColoringFeature extends Disposable {
	private _watchers: Record<string, ModelSemanticColoring>;

	constructor(modelService: IModelService, themeService: IThemeService) {
		super();
		this._watchers = Object.create(null);
		this._register(modelService.onModelAdded((model) => {
			this._watchers[model.uri.toString()] = new ModelSemanticColoring(model, themeService);
		}));
		this._register(modelService.onModelRemoved((model) => {
			this._watchers[model.uri.toString()].dispose();
			delete this._watchers[model.uri.toString()];
		}));
	}
}

class ModelSemanticColoring extends Disposable {

	private _isDisposed: boolean;
	private readonly _model: ITextModel;
	private readonly _fetchSemanticTokens: RunOnceScheduler;
	private _currentResponse: SemanticColoring | null;
	private _currentRequestCancellationTokenSource: CancellationTokenSource | null;
	private _themeService: IThemeService;

	constructor(model: ITextModel, themeService: IThemeService) {
		super();

		this._isDisposed = false;
		this._model = model;
		this._fetchSemanticTokens = this._register(new RunOnceScheduler(() => this._fetchSemanticTokensNow(), 500));
		this._currentResponse = null;
		this._currentRequestCancellationTokenSource = null;
		this._themeService = themeService;

		this._register(this._model.onDidChangeContent(e => this._fetchSemanticTokens.schedule()));
		this._register(SemanticColoringProviderRegistry.onDidChange(e => this._fetchSemanticTokens.schedule()));
		this._register(themeService.onThemeChange(_ => this._fetchSemanticTokens.schedule()));
		this._fetchSemanticTokens.schedule(0);
	}

	public dispose(): void {
		this._isDisposed = true;
		if (this._currentResponse) {
			this._currentResponse.dispose();
			this._currentResponse = null;
		}
		if (this._currentRequestCancellationTokenSource) {
			this._currentRequestCancellationTokenSource.cancel();
			this._currentRequestCancellationTokenSource = null;
		}
		super.dispose();
	}

	private _fetchSemanticTokensNow(): void {
		if (this._currentRequestCancellationTokenSource) {
			// there is already a request running, let it finish...
			return;
		}
		const provider = this._getSemanticColoringProvider();
		if (!provider) {
			return;
		}
		this._currentRequestCancellationTokenSource = new CancellationTokenSource();

		const pendingChanges: IModelContentChangedEvent[] = [];
		const contentChangeListener = this._model.onDidChangeContent((e) => {
			pendingChanges.push(e);
		});

		const request = Promise.resolve(provider.provideSemanticColoring(this._model, this._currentRequestCancellationTokenSource.token));

		request.then((res) => {
			this._currentRequestCancellationTokenSource = null;
			contentChangeListener.dispose();
			this._setSemanticTokens(res || null, provider.getLegend(), pendingChanges);
		}, (err) => {
			errors.onUnexpectedError(err);
			this._currentRequestCancellationTokenSource = null;
			contentChangeListener.dispose();
			this._setSemanticTokens(null, provider.getLegend(), pendingChanges);
		});
	}

	private _setSemanticTokens(tokens: SemanticColoring | null, legend: SemanticColoringLegend, pendingChanges: IModelContentChangedEvent[]): void {
		if (this._currentResponse) {
			this._currentResponse.dispose();
			this._currentResponse = null;
		}
		if (this._isDisposed) {
			// disposed!
			if (tokens) {
				tokens.dispose();
			}
			return;
		}
		this._currentResponse = tokens;
		if (!this._currentResponse) {
			this._model.setSemanticTokens(null);
			return;
		}

		const result: MultilineTokens2[] = [];
		for (const area of this._currentResponse.areas) {
			const srcTokens = area.data;
			const tokenCount = srcTokens.length / 5;
			let destTokens = new Uint32Array(4 * tokenCount);
			let destOffset = 0;
			for (let i = 0; i < tokenCount; i++) {
				const srcOffset = 5 * i;
				const deltaLine = srcTokens[srcOffset];
				const startCharacter = srcTokens[srcOffset + 1];
				const endCharacter = srcTokens[srcOffset + 2];
				const tokenTypeIndex = srcTokens[srcOffset + 3];
				const tokenType = legend.tokenTypes[tokenTypeIndex];

				let tokenModifierSet = srcTokens[srcOffset + 4];
				let tokenModifiers: string[] = [];
				for (let modifierIndex = 0; tokenModifierSet !== 0 && modifierIndex < legend.tokenModifiers.length; modifierIndex++) {
					if (tokenModifierSet & 1) {
						tokenModifiers.push(legend.tokenModifiers[modifierIndex]);
					}
					tokenModifierSet = tokenModifierSet >> 1;
				}

				const metadata = this._themeService.getTheme().getTokenStyleMetadata(tokenType, tokenModifiers);
				if (metadata !== undefined) {
					destTokens[destOffset] = deltaLine;
					destTokens[destOffset + 1] = startCharacter;
					destTokens[destOffset + 2] = endCharacter;
					destTokens[destOffset + 3] = metadata;
					destOffset += 4;
				}
			}

			if (destOffset !== destTokens.length) {
				destTokens = destTokens.subarray(0, destOffset);
			}
			const tokens = new MultilineTokens2(area.line, new SparseEncodedTokens(destTokens));
			result.push(tokens);
		}

		// Adjust incoming semantic tokens
		if (pendingChanges.length > 0) {
			// More changes occurred while the request was running
			// We need to:
			// 1. Adjust incoming semantic tokens
			// 2. Request them again
			for (const change of pendingChanges) {
				for (const area of result) {
					for (const singleChange of change.changes) {
						area.applyEdit(singleChange.range, singleChange.text);
					}
				}
			}

			this._fetchSemanticTokens.schedule();
		}

		this._model.setSemanticTokens(result);
	}

	private _getSemanticColoringProvider(): SemanticColoringProvider | null {
		const result = SemanticColoringProviderRegistry.ordered(this._model);
		return (result.length > 0 ? result[0] : null);
	}
}
