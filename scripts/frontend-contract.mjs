import { parse } from "acorn";

const RPC_METHOD_PATTERN = /^xsec\.[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/;

function fail(message) {
  throw new Error(message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function unwrapChain(node) {
  return node?.type === "ChainExpression" ? node.expression : node;
}

function memberName(member) {
  if (!member.computed && member.property.type === "Identifier") return member.property.name;
  if (member.computed && member.property.type === "Literal" && typeof member.property.value === "string") return member.property.value;
  return undefined;
}

function objectPropertyName(property) {
  if (property.type !== "Property") return undefined;
  if (!property.computed && property.key.type === "Identifier") return property.key.name;
  if (property.computed && property.key.type === "Literal" && typeof property.key.value === "string") return property.key.value;
  return undefined;
}

function isHost(node) {
  return unwrapChain(node)?.type === "Identifier" && unwrapChain(node).name === "host";
}

function isHostReference(node, parent) {
  if (!isHost(node)) return false;
  if (parent?.type === "MemberExpression" && parent.property === node && !parent.computed) return false;
  return !(parent?.type === "Property" && parent.key === node && !parent.computed && parent.value !== node);
}

function isHostRequestMember(node) {
  return node?.type === "MemberExpression" && isHost(node.object) && memberName(node) === "request";
}

function usesComputedHostMember(node) {
  return node?.type === "MemberExpression" && isHost(node.object) && node.computed;
}

function isRequestMember(node) {
  return node?.type === "MemberExpression" && memberName(node) === "request";
}

function isDirectCall(node, parent) {
  return parent?.type === "CallExpression" && unwrapChain(parent.callee) === node;
}

function patternBindsHost(pattern) {
  if (pattern?.type === "Identifier") return pattern.name === "host";
  if (pattern?.type === "RestElement" || pattern?.type === "AssignmentPattern") return patternBindsHost(pattern.argument ?? pattern.left);
  if (pattern?.type === "ArrayPattern") return pattern.elements.some(patternBindsHost);
  return pattern?.type === "ObjectPattern" && pattern.properties.some((property) => patternBindsHost(property.value ?? property.argument));
}

function declarationBindsHost(node, activationParameter) {
  if ((node.type === "VariableDeclarator" || node.type === "CatchClause") && patternBindsHost(node.id ?? node.param)) return true;
  if (["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(node.type)) {
    return node.id?.name === "host" || node.params.some((parameter) => parameter !== activationParameter && patternBindsHost(parameter));
  }
  if (["ClassDeclaration", "ClassExpression"].includes(node.type)) return node.id?.name === "host";
  return node.type === "ImportDeclaration" && node.specifiers.some((specifier) => specifier.local?.name === "host");
}

function validatesHostBinding(node, parent, activationParameter) {
  if (node === activationParameter) return;
  if (declarationBindsHost(node, activationParameter)) fail("frontend cannot shadow the activation host parameter");
  if (node.type === "AssignmentExpression" && patternBindsHost(node.left)) fail("frontend cannot reassign the activation host parameter");
  if (isHostReference(node, parent) && !(parent?.type === "MemberExpression" && parent.object === node)) fail("frontend host parameter can only be used as a direct member receiver");
}

function activationHostParameter(program) {
  const activation = program.body.find((node) => node.type === "ExportNamedDeclaration" && node.declaration?.type === "FunctionDeclaration" && node.declaration.id?.name === "activate")?.declaration;
  const parameter = activation?.params?.[0];
  if (parameter?.type !== "Identifier" || parameter.name !== "host") fail("frontend activate function must receive the host parameter directly");
  return parameter;
}

function requestMethod(node) {
  const callee = unwrapChain(node.callee);
  if (!isHostRequestMember(callee)) return undefined;
  if (callee.optional || node.optional) fail("frontend host.request calls cannot be optional");
  const method = node.arguments[0];
  if (method?.type !== "Literal" || typeof method.value !== "string" || !RPC_METHOD_PATTERN.test(method.value)) {
    fail("frontend host.request calls must use literal XSEC RPC method names");
  }
  return method.value;
}

function visitAst(node, callback, parent) {
  if (!isRecord(node)) return;
  callback(node, parent);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((entry) => visitAst(entry, callback, node));
    else if (isRecord(value) && typeof value.type === "string") visitAst(value, callback, node);
  }
}

function objectPatternReadsRequest(pattern) {
  return pattern?.type === "ObjectPattern"
    && pattern.properties.some((property) => property.type === "RestElement" || objectPropertyName(property) === "request");
}

function destructuresHostRequest(node) {
  if (node.type === "VariableDeclarator") return isHost(node.init) && objectPatternReadsRequest(node.id);
  if (node.type === "AssignmentExpression") return isHost(node.right) && objectPatternReadsRequest(node.left);
  return false;
}

function aliasesHost(node) {
  return (node.type === "VariableDeclarator" && isHost(node.init))
    || (node.type === "AssignmentExpression" && isHost(node.right));
}

function validatesHostRequestUse(node, parent) {
  if (aliasesHost(node)) fail("frontend cannot alias the host object");
  if (destructuresHostRequest(node)) fail("frontend cannot destructure host.request");
  if (usesComputedHostMember(node)) fail("frontend host members cannot use computed access");
  if (isRequestMember(node) && isDirectCall(node, parent) && !isHostRequestMember(node)) fail("frontend request calls must use the host object directly");
  if (node.type !== "MemberExpression" || !isHostRequestMember(node)) return;
  if (!isDirectCall(node, parent)) fail("frontend must call host.request directly with a literal method name");
}

export function frontendRequestMethods(source) {
  const methods = new Set();
  const program = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  const activationParameter = activationHostParameter(program);
  visitAst(program, (node, parent) => {
    if (node.type === "ImportDeclaration" || node.type === "ImportExpression"
      || ((node.type === "ExportNamedDeclaration" || node.type === "ExportAllDeclaration") && node.source !== null)) {
      fail("frontend must be a single ESM file without module dependencies");
    }
    validatesHostBinding(node, parent, activationParameter);
    validatesHostRequestUse(node, parent);
    if (node.type === "CallExpression") {
      const method = requestMethod(node);
      if (method) methods.add(method);
    }
  });
  return methods;
}
