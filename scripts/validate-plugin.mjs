import Ajv2020 from "ajv/dist/2020.js";
import { parse } from "acorn";
import semver from "semver";
import { constants } from "node:fs";
import { access, lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve, sep, win32 } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_ID = "com.xsec.workspace.approvals";
const SCHEMA_URL = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const PLUGIN_ROOT = resolve(process.argv[2] ?? `${ROOT}/plugins/${PLUGIN_ID}`);
const IGNORED_DIRECTORIES = new Set([".git", ".xsec-build", ".xsec-market", "node_modules", "__pycache__"]);
const RESERVED_DEVICES = new Set(["CON", "PRN", "AUX", "NUL", "CLOCK$", "CONIN$", "CONOUT$"]);
const ROOT_KEYS = new Set(["$schema", "name", "version", "description", "author", "homepage", "repository", "license", "keywords", "extensions"]);
const MARKET_KEYS = new Set(["name", "version", "description", "author", "license", "repository", "interface"]);
const INTERFACE_KEYS = new Set(["displayName", "shortDescription", "longDescription", "developerName", "category", "capabilities", "websiteURL", "defaultPrompt", "brandColor"]);
const NAME_PATTERN = /^(?=.{1,64}$)[a-z0-9](?!.*(?:--|\.\.))[a-z0-9.-]*[a-z0-9]$|^[a-z0-9]$/;
const ENTRYPOINT_COMPONENTS = /^[\x20-\x7e]+$/;
const RPC_METHOD_PATTERN = /^xsec\.[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/;
const REQUIRED_ACTIVATIONS = new Map([
  ["onWorkspaceTool:approvals", "workspaceTools"],
  ["onSettingsPage:approvals", "settingsPages"],
]);
const ACTIVATION_COLLECTIONS = new Map([
  ["Command", "commands"], ["Route", "routes"], ["WorkspaceTool", "workspaceTools"],
  ["AgentTool", "agentTools"], ["SettingsPage", "settingsPages"],
]);

function fail(message) {
  throw new Error(message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(value, label) {
  if (!isRecord(value)) fail(`${label} must be an object`);
  return value;
}

function requireString(value, label) {
  if (typeof value !== "string" || !value.trim()) fail(`${label} must be a non-empty string`);
  return value;
}

function requireExactKeys(value, keys, label) {
  for (const key of Object.keys(value)) if (!keys.has(key)) fail(`${label} has an unsupported field: ${key}`);
}

function readJson(path, label) {
  return readFile(path, "utf8").then((source) => {
    try {
      return JSON.parse(source);
    } catch (error) {
      fail(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

function validateRootManifest(manifest) {
  requireExactKeys(manifest, ROOT_KEYS, "plugin.json");
  if (manifest.$schema !== SCHEMA_URL) fail("plugin.json has an unsupported Agent Plugins schema");
  if (!NAME_PATTERN.test(requireString(manifest.name, "plugin.json name"))) fail("plugin.json name violates the Agent Plugins package-name contract");
  if (!semver.valid(requireString(manifest.version, "plugin.json version"))) fail("plugin.json version must be valid SemVer");
  for (const key of ["description", "homepage", "repository", "license"]) {
    if (manifest[key] !== undefined && typeof manifest[key] !== "string") fail(`plugin.json ${key} must be a string`);
  }
  if (manifest.author !== undefined) validateAuthor(manifest.author, "plugin.json author");
  if (manifest.keywords !== undefined && (!Array.isArray(manifest.keywords) || manifest.keywords.some((entry) => typeof entry !== "string"))) {
    fail("plugin.json keywords must be an array of strings");
  }
  const extensions = requireRecord(manifest.extensions, "plugin.json extensions");
  return requireRecord(extensions["com.xsec.desktop"], "XSEC Desktop extension");
}

function validateAuthor(author, label) {
  requireExactKeys(requireRecord(author, label), new Set(["name", "email", "url"]), label);
  for (const [key, value] of Object.entries(author)) if (typeof value !== "string") fail(`${label}.${key} must be a string`);
}

function validateDesktopSchema(extension, schema) {
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, strictTypes: false });
  const validate = ajv.compile(schema);
  if (validate(extension)) return;
  const details = (validate.errors ?? []).map((error) => `${error.instancePath || "$"} ${error.message}`).join("; ");
  fail(`XSEC Desktop extension violates the pinned Desktop schema: ${details}`);
}

function rangeMeetsMinimum(range, version) {
  const normalized = range.split(",").map((part) => part.trim()).join(" ");
  const minimum = semver.minVersion(normalized);
  return minimum !== null && semver.gte(minimum, version) && semver.intersects(normalized, `>=${version} <2.0.0`);
}

function validateFrontendApi(extension) {
  const api = extension.frontendApi;
  if (!api) return;
  const range = extension.engines.pluginApi;
  if (!extension.entrypoints?.frontend) fail("frontendApi requires a frontend entrypoint");
  if (!rangeMeetsMinimum(range, "1.1.0")) fail("frontendApi v2 requires Plugin API 1.1+");
  const methods = Object.entries(api.methods);
  if (methods.some(([, method]) => method.binding === "context" || method.binding === "plugin")
    && !rangeMeetsMinimum(range, "1.2.0")) fail("frontendApi context/plugin binding requires Plugin API 1.2+");
  if (methods.some(([, method]) => method.capability === "workspace.tool.open") && !rangeMeetsMinimum(range, "1.3.0")) fail("workspace.tool.open requires Plugin API 1.3+");
  if (methods.some(([, method]) => method.capability === "workspace.composer.write")
    && !rangeMeetsMinimum(range, "1.4.0")) fail("workspace.composer.write requires Plugin API 1.4+");
  const declared = new Set(Object.keys(extension.permissions ?? {}).map((permission) => permission.split(":", 1)[0]));
  for (const [method, declaration] of methods) if (!declared.has(declaration.capability)) fail(`frontend RPC ${method} uses an undeclared capability`);
}

function componentIsReserved(component) {
  const stem = component.split(".", 1)[0].toUpperCase();
  return RESERVED_DEVICES.has(stem) || /^(COM|LPT)[1-9]$/.test(stem);
}

function validatePortablePath(entrypoint) {
  const parts = entrypoint.replace(/^\.\//, "").split("/");
  if (!entrypoint.startsWith("./") || parts.some((part) => !part || part === "." || part === ".." || !ENTRYPOINT_COMPONENTS.test(part))) {
    fail(`entrypoint is not a portable relative path: ${entrypoint}`);
  }
  for (const part of parts) {
    if (part.includes("\\") || part.endsWith(".") || part.endsWith(" ") || part.includes(":") || /[<>"|?*\x00-\x1f]/.test(part) || componentIsReserved(part)) {
      fail(`entrypoint contains a Windows-invalid component: ${entrypoint}`);
    }
  }
}

function isContained(pathApi, candidate) {
  if (pathApi.isAbsolute(candidate)) return false;
  const pathRelative = pathApi.relative(pathApi.resolve(PLUGIN_ROOT), pathApi.resolve(PLUGIN_ROOT, candidate));
  return pathRelative !== ".." && !pathRelative.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(pathRelative);
}

function declaredEntrypoints(extension) {
  const entrypoints = Object.entries(extension.entrypoints ?? {});
  const services = Object.entries(extension.contributes?.backgroundServices ?? {})
    .map(([id, service]) => [`background service ${id}`, service.entrypoint]);
  return [...entrypoints, ...services];
}

async function validateEntrypoint(kind, entrypoint) {
  validatePortablePath(entrypoint);
  if (!isContained(posix, entrypoint) || !isContained(win32, entrypoint)) fail(`${kind} entrypoint leaves the plugin root`);
  const resolved = resolve(PLUGIN_ROOT, entrypoint);
  const details = await lstat(resolved);
  if (!details.isFile() || details.isSymbolicLink()) fail(`${kind} entrypoint must be a regular file`);
  const pathRelative = relative(await realpath(PLUGIN_ROOT), await realpath(resolved));
  if (pathRelative === ".." || pathRelative.startsWith(`..${sep}`) || isAbsolute(pathRelative)) fail(`${kind} entrypoint resolves outside the plugin root`);
  if (kind === "frontend") await syntaxCheck(resolved);
}

async function validateEntrypoints(extension) {
  for (const [kind, entrypoint] of declaredEntrypoints(extension)) await validateEntrypoint(kind, entrypoint);
}

async function syntaxCheck(path) {
  await access(path, constants.R_OK);
  const { spawn } = await import("node:child_process");
  await new Promise((resolveCheck, rejectCheck) => {
    const child = spawn(process.execPath, ["--check", path], { stdio: "inherit" });
    child.once("error", rejectCheck);
    child.once("exit", (code) => code === 0 ? resolveCheck() : rejectCheck(new Error(`frontend syntax check failed with exit code ${code}`)));
  });
}

function unwrapChain(node) {
  return node?.type === "ChainExpression" ? node.expression : node;
}

function memberName(member) {
  if (!member.computed && member.property.type === "Identifier") return member.property.name;
  if (member.computed && member.property.type === "Literal" && typeof member.property.value === "string") return member.property.value;
  return undefined;
}

function frontendRequestMethod(node) {
  const callee = unwrapChain(node.callee);
  if (node.type !== "CallExpression" || callee?.type !== "MemberExpression" || unwrapChain(callee.object)?.name !== "host" || memberName(callee) !== "request") return undefined;
  const method = node.arguments[0];
  if (method?.type !== "Literal" || typeof method.value !== "string" || !RPC_METHOD_PATTERN.test(method.value)) fail("frontend host.request calls must use literal XSEC RPC method names");
  return method.value;
}

function visitAst(node, callback) {
  if (!isRecord(node)) return;
  callback(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((entry) => visitAst(entry, callback));
    else if (isRecord(value) && typeof value.type === "string") visitAst(value, callback);
  }
}

function frontendRequestMethods(source) {
  const methods = new Set();
  const program = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  visitAst(program, (node) => {
    const method = frontendRequestMethod(node);
    if (method) methods.add(method);
  });
  return methods;
}

async function validateFrontendRequests(extension) {
  const frontend = extension.entrypoints?.frontend;
  if (!frontend) return;
  const source = await readFile(resolve(PLUGIN_ROOT, frontend), "utf8");
  const used = frontendRequestMethods(source);
  if (!extension.frontendApi && used.size) fail("frontend broker calls require a frontendApi declaration");
  if (!extension.frontendApi) return;
  const declared = new Set(Object.keys(extension.frontendApi.methods));
  for (const method of used) if (!declared.has(method)) fail(`frontend RPC ${method} is not declared in plugin.json`);
  for (const method of declared) if (!used.has(method)) fail(`plugin.json declares unused frontend RPC ${method}`);
}

function activationTarget(event) {
  const match = /^on(Command|Route|WorkspaceTool|AgentTool|SettingsPage):([a-z0-9][a-z0-9._-]*)$/.exec(event);
  return match ? { collection: ACTIVATION_COLLECTIONS.get(match[1]), id: match[2] } : undefined;
}

function validateActivationContributions(extension) {
  const events = new Set(extension.activationEvents ?? []);
  for (const [event, collection] of REQUIRED_ACTIVATIONS) {
    if (!events.has(event) || !extension.contributes?.[collection]?.approvals) fail(`approvals must retain ${event} and its ${collection}.approvals contribution`);
  }
  for (const event of events) {
    const target = activationTarget(event);
    if (target && !extension.contributes?.[target.collection]?.[target.id]) fail(`activation event ${event} has no matching contribution`);
  }
}

function validateArchiveComponent(component, archivePath) {
  if (![...component].every((character) => character.charCodeAt(0) <= 0x7f)) fail(`plugin tree path must be ASCII: ${archivePath}`);
  if (component.endsWith(".") || component.endsWith(" ") || component.includes(":") || /[<>"|?*\x00-\x1f]/.test(component) || componentIsReserved(component)) {
    fail(`plugin tree path is not Windows-portable: ${archivePath}`);
  }
}

async function validatePortableTree(current = PLUGIN_ROOT, paths = new Map()) {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
    const absolute = resolve(current, entry.name);
    const archivePath = relative(PLUGIN_ROOT, absolute).replaceAll("\\", "/");
    if (!archivePath || archivePath.includes("\\") || archivePath.split("/").some((part) => !part || part === "." || part === "..")) fail(`plugin tree path is unsafe: ${archivePath || absolute}`);
    for (const component of archivePath.split("/")) validateArchiveComponent(component, archivePath);
    const collision = paths.get(archivePath.toLowerCase());
    if (collision && collision !== archivePath) fail(`plugin tree has a case-insensitive path collision: ${collision} and ${archivePath}`);
    paths.set(archivePath.toLowerCase(), archivePath);
    const details = await lstat(absolute);
    if (details.isSymbolicLink()) fail(`plugin tree contains a symbolic link: ${archivePath}`);
    if (details.isDirectory()) await validatePortableTree(absolute, paths);
    else if (!details.isFile()) fail(`plugin tree contains an unsupported file type: ${archivePath}`);
  }
}

function validateMarketplaceMetadata(metadata, manifest, extension) {
  requireExactKeys(metadata, MARKET_KEYS, "marketplace metadata");
  for (const key of ["name", "version", "description", "license", "repository"]) requireString(metadata[key], `marketplace metadata ${key}`);
  if (metadata.name !== PLUGIN_ID || metadata.name !== manifest.name || metadata.version !== manifest.version) fail("marketplace metadata identity does not match the plugin manifest");
  if (metadata.description !== manifest.description || metadata.license !== manifest.license) fail("marketplace metadata must match the plugin manifest fields");
  if (!/^https:\/\/github\.com\/tzf1003\/xsec-plugins$/.test(metadata.repository)) fail("marketplace metadata repository must identify the XSEC marketplace");
  requireString(manifest.author?.name, "plugin.json author name");
  validateAuthor(metadata.author, "marketplace metadata author");
  requireString(metadata.author.name, "marketplace metadata author name");
  if (metadata.author.name !== manifest.author?.name) fail("marketplace metadata author must match the plugin manifest");
  const descriptor = requireRecord(metadata.interface, "marketplace metadata interface");
  requireExactKeys(descriptor, INTERFACE_KEYS, "marketplace metadata interface");
  for (const key of ["displayName", "shortDescription", "longDescription", "developerName", "category", "websiteURL", "brandColor"]) requireString(descriptor[key], `marketplace interface ${key}`);
  if (descriptor.displayName !== extension.displayName || descriptor.shortDescription !== manifest.description || descriptor.developerName !== manifest.author?.name) fail("marketplace interface does not match the Desktop manifest");
  if (descriptor.websiteURL !== metadata.repository || !/^#[0-9A-Fa-f]{6}$/.test(descriptor.brandColor)) fail("marketplace interface has an invalid website URL or brand color");
  if (!Array.isArray(descriptor.capabilities) || !descriptor.capabilities.length || descriptor.capabilities.some((entry) => typeof entry !== "string" || !entry.trim())) fail("marketplace capabilities must be non-empty strings");
  if (!Array.isArray(descriptor.defaultPrompt) || !descriptor.defaultPrompt.length || descriptor.defaultPrompt.some((entry) => typeof entry !== "string" || !entry.trim())) fail("marketplace defaultPrompt must be non-empty strings");
}

async function main() {
  const [manifest, schema, metadata] = await Promise.all([
    readJson(`${PLUGIN_ROOT}/plugin.json`, "plugin.json"),
    readJson(`${ROOT}/schemas/com.xsec.desktop.schema.json`, "pinned Desktop schema"),
    readJson(`${PLUGIN_ROOT}/.codex-plugin/plugin.json`, "marketplace metadata"),
  ]);
  const rootManifest = requireRecord(manifest, "plugin.json");
  const extension = validateRootManifest(rootManifest);
  validateDesktopSchema(extension, schema);
  validateFrontendApi(extension);
  validateActivationContributions(extension);
  await validateEntrypoints(extension);
  await validateFrontendRequests(extension);
  await validatePortableTree();
  validateMarketplaceMetadata(requireRecord(metadata, "marketplace metadata"), rootManifest, extension);
  console.log(`validated ${rootManifest.name}@${rootManifest.version}`);
}

await main();
