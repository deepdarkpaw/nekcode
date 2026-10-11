import type {
	AnyModel,
	Api,
	AssistantImages,
	AssistantMessage,
	AssistantMessageEventStream,
	AuthCheck,
	AuthInteraction,
	AuthOperationOptions,
	AuthResult,
	AuthType,
	ClassifierApi,
	ClassifierContext,
	ClassifierModel,
	ClassifierResult,
	Context,
	Credential,
	DeferredHandle,
	ImageApi,
	ImageModel,
	ImagesContext,
	Model,
	Models,
	ModelsApiStreamOptions,
	ModelsClassifierOptions,
	ModelsDeferredCancelOptions,
	ModelsDeferredFetchOptions,
	ModelsImagesOptions,
	ModelsRefreshOptions,
	ModelsRefreshResult,
	ModelsSimpleStreamOptions,
	ModelType,
	ModelTypeMap,
	Provider,
	ProviderHeaders,
	ProviderResponse,
} from "@earendil-works/pi-ai";

type AuthOverrides = Parameters<Models["getAuth"]>[1];

/**
 * Pi's provider extension points, injected as plain functions so the engine does not depend on `ExtensionRunner`.
 * Each maps to one extension event: `before_provider_request`, `before_provider_headers`, `after_provider_response`,
 * and `provider_stream_event`.
 */
export interface ProviderHooks {
	/** `before_provider_request`: inspect or replace the provider payload. */
	transformPayload?(payload: unknown, model: Model<Api>): Promise<unknown>;
	/** Provider attribution and `before_provider_headers`. `sessionId` is the request's routing session. */
	transformHeaders?(
		headers: ProviderHeaders,
		model: Model<Api>,
		sessionId: string | undefined,
	): Promise<ProviderHeaders>;
	/** `after_provider_response`. */
	afterResponse?(response: ProviderResponse, model: Model<Api>): Promise<void>;
	/** `provider_stream_event`. */
	streamEvent?(data: unknown, model: Model<Api>): Promise<void>;
	/**
	 * Request options that live only in this process and so cannot be pinned in durable checkpoints, such as thinking
	 * budgets and the WebSocket connect timeout. The request's own options override them.
	 */
	requestOptions?(model: Model<Api>): ModelsSimpleStreamOptions;
	/** Called with the exact request options immediately before a real provider stream starts. */
	beforeStream?(model: Model<Api>, context: Context, options: ModelsSimpleStreamOptions): void;
}

/**
 * `Models` decorator used as `HarnessOptions.models`: delegates everything to `inner` and routes every chat request
 * through the injected provider hooks, so durable generations and compactions see the same provider extension
 * behavior as pi's agent loop.
 */
export class HookedModels implements Models {
	#inner: Models;
	#hooks: ProviderHooks;
	#fallbackModel?: Model<Api>;

	constructor(inner: Models, hooks: ProviderHooks) {
		this.#inner = inner;
		this.#hooks = hooks;
	}

	/** Use the explicitly selected model when a provider exposes a request handler without a catalog entry. */
	setFallbackModel(model: Model<Api> | undefined): void {
		this.#fallbackModel = model;
	}

	/** Route later calls to `inner` with `hooks`; a session store opens its Harness before the host binds models. */
	reconfigure(inner: Models, hooks: ProviderHooks): void {
		this.#inner = inner;
		this.#hooks = hooks;
	}

	/** Request options with the provider hooks chained after any callbacks the caller already set. */
	#withHooks(model: Model<Api>, options: ModelsSimpleStreamOptions | undefined): ModelsSimpleStreamOptions {
		const hooks = this.#hooks;
		const base: ModelsSimpleStreamOptions = { ...hooks.requestOptions?.(model), ...options };
		const { onPayload, onResponse, onProviderStreamEvent, transformHeaders } = base;
		return {
			...base,
			...(hooks.transformPayload === undefined
				? {}
				: {
						onPayload: async (payload, payloadModel) => {
							const first = onPayload === undefined ? undefined : await onPayload(payload, payloadModel);
							return hooks.transformPayload!(first ?? payload, payloadModel);
						},
					}),
			...(hooks.afterResponse === undefined
				? {}
				: {
						onResponse: async (response, responseModel) => {
							await onResponse?.(response, responseModel);
							await hooks.afterResponse!(response, responseModel);
						},
					}),
			...(hooks.streamEvent === undefined
				? {}
				: {
						onProviderStreamEvent: async (data, eventModel) => {
							await onProviderStreamEvent?.(data, eventModel);
							await hooks.streamEvent!(data, eventModel);
						},
					}),
			...(hooks.transformHeaders === undefined
				? {}
				: {
						transformHeaders: async (headers) => {
							const first = transformHeaders === undefined ? headers : await transformHeaders(headers);
							return hooks.transformHeaders!(first, model, base.sessionId);
						},
					}),
		};
	}

	streamSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): AssistantMessageEventStream {
		const requestOptions = this.#withHooks(model, options);
		this.#hooks.beforeStream?.(model, context, requestOptions);
		return this.#inner.streamSimple(model, context, requestOptions);
	}

	completeSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): Promise<AssistantMessage> {
		return this.#inner.completeSimple(model, context, this.#withHooks(model, options));
	}

	stream<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): AssistantMessageEventStream {
		return this.#inner.stream(model, context, options);
	}

	complete<TApi extends Api>(
		model: Model<TApi>,
		context: Context,
		options?: ModelsApiStreamOptions<TApi>,
	): Promise<AssistantMessage> {
		return this.#inner.complete(model, context, options);
	}

	streamDeferred(
		model: Model<Api>,
		handle: DeferredHandle,
		options?: ModelsDeferredFetchOptions,
	): AssistantMessageEventStream {
		return this.#inner.streamDeferred(model, handle, options);
	}

	fetchDeferred(
		model: Model<Api>,
		handle: DeferredHandle,
		options?: ModelsDeferredFetchOptions,
	): Promise<AssistantMessage> {
		return this.#inner.fetchDeferred(model, handle, options);
	}

	cancelDeferred(model: Model<Api>, handle: DeferredHandle, options?: ModelsDeferredCancelOptions): Promise<void> {
		return this.#inner.cancelDeferred(model, handle, options);
	}

	generateImages(
		model: ImageModel<ImageApi>,
		context: ImagesContext,
		options?: ModelsImagesOptions,
	): Promise<AssistantImages> {
		return this.#inner.generateImages(model, context, options);
	}

	classify(
		model: ClassifierModel<ClassifierApi>,
		context: ClassifierContext,
		options?: ModelsClassifierOptions,
	): Promise<ClassifierResult> {
		return this.#inner.classify(model, context, options);
	}

	getProviders(): readonly Provider[] {
		return this.#inner.getProviders();
	}

	getProvider(id: string): Provider | undefined {
		return this.#inner.getProvider(id);
	}

	getModels(provider?: string): readonly Model<Api>[] {
		return this.#inner.getModels(provider);
	}

	getModel(provider: string, id: string): Model<Api> | undefined {
		const model = this.#inner.getModel(provider, id);
		if (model !== undefined) return model;
		const fallback = this.#fallbackModel;
		return fallback?.provider === provider && fallback.id === id ? fallback : undefined;
	}

	getModelsOfType<TType extends ModelType>(type: TType, provider?: string): readonly ModelTypeMap[TType][] {
		return this.#inner.getModelsOfType(type, provider);
	}

	getModelOfType<TType extends ModelType>(type: TType, provider: string, id: string): ModelTypeMap[TType] | undefined {
		return this.#inner.getModelOfType(type, provider, id);
	}

	getAllModels(provider?: string): readonly AnyModel[] {
		return this.#inner.getAllModels(provider);
	}

	refresh(options?: ModelsRefreshOptions): Promise<ModelsRefreshResult> {
		return this.#inner.refresh(options);
	}

	checkAuth(providerId: string, options?: AuthOperationOptions): Promise<AuthCheck | undefined> {
		return this.#inner.checkAuth(providerId, options);
	}

	getAvailable(providerId?: string, options?: AuthOperationOptions): Promise<readonly Model<Api>[]> {
		return this.#inner.getAvailable(providerId, options);
	}

	getAvailableOfType<TType extends ModelType>(
		type: TType,
		providerId?: string,
		options?: AuthOperationOptions,
	): Promise<readonly ModelTypeMap[TType][]> {
		return this.#inner.getAvailableOfType(type, providerId, options);
	}

	getAllAvailable(providerId?: string, options?: AuthOperationOptions): Promise<readonly AnyModel[]> {
		return this.#inner.getAllAvailable(providerId, options);
	}

	getAuth(providerId: string, overrides?: AuthOverrides): Promise<AuthResult | undefined>;
	getAuth(model: AnyModel, overrides?: AuthOverrides): Promise<AuthResult | undefined>;
	getAuth(providerOrModel: string | AnyModel, overrides?: AuthOverrides): Promise<AuthResult | undefined> {
		return typeof providerOrModel === "string"
			? this.#inner.getAuth(providerOrModel, overrides)
			: this.#inner.getAuth(providerOrModel, overrides);
	}

	login(providerId: string, type: AuthType, interaction: AuthInteraction): Promise<Credential> {
		return this.#inner.login(providerId, type, interaction);
	}

	logout(providerId: string, options?: AuthOperationOptions): Promise<void> {
		return this.#inner.logout(providerId, options);
	}
}
