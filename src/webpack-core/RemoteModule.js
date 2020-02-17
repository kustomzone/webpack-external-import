const { OriginalSource, RawSource } = require("webpack-sources");
const Module = require("webpack/lib/Module");
const RuntimeGlobals = require("webpack/lib/RuntimeGlobals");
const Template = require("webpack/lib/Template");

const getSourceForGlobalVariableExternal = (variableName, type) => {
  if (!Array.isArray(variableName)) {
    // make it an array as the look up works the same basically
    variableName = [variableName];
  }
  console.log("getSourceForGlobalVariableExternal");
  // needed for e.g. window["some"]["thing"]
  const objectLookup = variableName.map(r => `[${JSON.stringify(r)}]`).join("");
  return `(function() { module.exports = ${type}${objectLookup}; }());`;
};

/**
 * @param {string|string[]} moduleAndSpecifiers the module request
 * @returns {string} the generated source
 */
const getSourceForCommonJsExternal = moduleAndSpecifiers => {
  console.log("getSourceForCommonJsExternal");
  if (!Array.isArray(moduleAndSpecifiers)) {
    return `module.exports = require(${JSON.stringify(moduleAndSpecifiers)});`;
  }
  const moduleName = moduleAndSpecifiers[0];
  const objectLookup = moduleAndSpecifiers
    .slice(1)
    .map(r => `[${JSON.stringify(r)}]`)
    .join("");
  return `module.exports = require(${JSON.stringify(
    moduleName
  )})${objectLookup};`;
};

/**
 * @param {string} variableName the variable name to check
 * @param {string} request the request path
 * @param {RuntimeTemplate} runtimeTemplate the runtime template
 * @returns {string} the generated source
 */
const checkExternalVariable = (variableName, request, runtimeTemplate) => {
  return `if(typeof ${variableName} === 'undefined') { ${runtimeTemplate.throwMissingModuleErrorBlock(
    { request }
  )} }\n`;
};

/**
 * @param {string|number} id the module id
 * @param {boolean} optional true, if the module is optional
 * @param {string|string[]} request the request path
 * @param {RuntimeTemplate} runtimeTemplate the runtime template
 * @returns {string} the generated source
 */
const getSourceForAmdOrUmdExternal = (
  id,
  optional,
  request,
  runtimeTemplate
) => {
  const externalVariable = `__WEBPACK_REMOTE_MODULE_${Template.toIdentifier(
    `${id}`
  )}__`;
  const missingModuleError = optional
    ? checkExternalVariable(
        externalVariable,
        Array.isArray(request) ? request.join(".") : request,
        runtimeTemplate
      )
    : "";
  console.log("getSourceForAmdOrUmdExternal");
  return `${missingModuleError}module.exports = ${externalVariable};`;
};

/**
 * @param {boolean} optional true, if the module is optional
 * @param {string|string[]} request the request path
 * @param {RuntimeTemplate} runtimeTemplate the runtime template
 * @returns {string} the generated source
 */
const getSourceForDefaultCase = (
  optional,
  request,
  runtimeTemplate,
  requestScope
) => {
  if (!Array.isArray(request)) {
    // make it an array as the look up works the same basically
    request = [request];
  }

  // TODO: use this for error handling
  const missingModuleError = optional
    ? checkExternalVariable(requestScope, request.join("."), runtimeTemplate)
    : "";

  // refactor conditional into checkExternalVariable
  Template.asString([
    "module.exports = ",
    `typeof ${requestScope} !== 'undefined' ? ${requestScope}.get('${request}') : `,
    `new Promise.reject("Missing Federated Bundle: ${requestScope} cannot be found when trying to import ${request}")); `
  ]);

  return `module.exports = ${requestScope}.get('${request}')`;
};

const TYPES = new Set(["javascript"]);
const RUNTIME_REQUIREMENTS = new Set([RuntimeGlobals.module]);

class RemoteModule extends Module {
  constructor(request, type, userRequest) {
    super("javascript/dynamic", null);

    this.requestScope = request?.split("/")?.shift?.();
    // Info from Factory
    /** @type {string | string[] | Record<string, string | string[]>} */
    this.request = request?.split(`${this.requestScope}/`)?.[1];
    /** @type {string} */
    this.externalType = type;
    /** @type {string} */
    this.userRequest = userRequest;
  }

  /**
   * @returns {Set<string>} types availiable (do not mutate)
   */
  getSourceTypes() {
    return TYPES;
  }

  /**
   * @param {LibIdentOptions} options options
   * @returns {string | null} an identifier for library inclusion
   */
  libIdent(options) {
    return this.userRequest;
  }

  /**
   * @param {Chunk} chunk the chunk which condition should be checked
   * @param {Compilation} compilation the compilation
   * @returns {boolean} true, if the chunk is ok for the module
   */
  chunkCondition(chunk, { chunkGraph }) {
    return chunkGraph.getNumberOfEntryModules(chunk) > 0;
  }

  /**
   * @returns {string} a unique identifier of the module
   */
  identifier() {
    return `remote ${JSON.stringify(this.request)}`;
  }

  /**
   * @param {RequestShortener} requestShortener the request shortener
   * @returns {string} a user readable identifier of the module
   */
  readableIdentifier(requestShortener) {
    return `remote ${JSON.stringify(this.request)}`;
  }

  /**
   * @param {NeedBuildContext} context context info
   * @param {function(WebpackError=, boolean=): void} callback callback function, returns true, if the module needs a rebuild
   * @returns {void}
   */
  needBuild(context, callback) {
    return callback(null, !this.buildMeta);
  }

  /**
   * @param {WebpackOptions} options webpack options
   * @param {Compilation} compilation the compilation
   * @param {ResolverWithOptions} resolver the resolver
   * @param {InputFileSystem} fs the file system
   * @param {function(WebpackError=): void} callback callback function
   * @returns {void}
   */
  build(options, compilation, resolver, fs, callback) {
    this.buildMeta = {};
    this.buildInfo = {
      strict: true
    };
    callback();
  }

  getSourceString(runtimeTemplate, moduleGraph, chunkGraph) {
    const request =
      typeof this.request === "object" && !Array.isArray(this.request)
        ? this.request[this.externalType]
        : this.request;
    switch (this.externalType) {
      case "this":
      case "window":
      case "self":
        return getSourceForGlobalVariableExternal(request, this.externalType);
      case "global":
        return getSourceForGlobalVariableExternal(
          request,
          runtimeTemplate.outputOptions.globalObject
        );
      case "commonjs":
      case "commonjs2":
        return getSourceForCommonJsExternal(request);
      case "amd":
      case "amd-require":
      case "umd":
      case "umd2":
      case "system":
        return getSourceForAmdOrUmdExternal(
          chunkGraph.getModuleId(this),
          this.isOptional(moduleGraph),
          request,
          runtimeTemplate
        );
      default:
        return getSourceForDefaultCase(
          this.isOptional(moduleGraph),
          request,
          runtimeTemplate,
          this.requestScope
        );
    }
  }

  /**
   * @param {CodeGenerationContext} context context for code generation
   * @returns {CodeGenerationResult} result
   */
  codeGeneration({ runtimeTemplate, moduleGraph, chunkGraph }) {
    const sourceString = this.getSourceString(
      runtimeTemplate,
      moduleGraph,
      chunkGraph
    );

    const sources = new Map();
    if (this.useSourceMap) {
      sources.set(
        "javascript",
        new OriginalSource(sourceString, this.identifier())
      );
    } else {
      sources.set("javascript", new RawSource(sourceString));
    }
    return { sources, runtimeRequirements: RUNTIME_REQUIREMENTS };
  }

  /**
   * @param {string=} type the source type for which the size should be estimated
   * @returns {number} the estimated size of the module (must be non-zero)
   */
  size(type) {
    return 42;
  }

  /**
   * @param {Hash} hash the hash used to track dependencies
   * @param {ChunkGraph} chunkGraph the chunk graph
   * @returns {void}
   */
  updateHash(hash, chunkGraph) {
    // hash.update(this.externalType);
    hash.update(JSON.stringify(this.request));
    // hash.update(
    //   JSON.stringify(Boolean(this.isOptional(chunkGraph.moduleGraph)))
    // );
    // super.updateHash(hash, chunkGraph);
  }

  serialize(context) {
    const { write } = context;

    write(this.request);
    write(this.externalType);
    write(this.userRequest);

    super.serialize(context);
  }

  deserialize(context) {
    const { read } = context;

    this.request = read();
    this.externalType = read();
    this.userRequest = read();

    super.deserialize(context);
  }
}

module.exports = RemoteModule;
