import { COMPONENT_SPECS, FOUNDATION_PAGES, TYPOGRAPHY_SPECS } from "./componentSpecs.js";

function findPageNames(fileBody) {
  const pages = fileBody?.document?.children || [];
  return pages.map((p) => p?.name).filter(Boolean);
}

function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  visit(node);
  const children = Array.isArray(node.children) ? node.children : [];
  for (const child of children) walk(child, visit);
}

function summarizeNodes(fileBody) {
  const names = new Set();
  walk(fileBody?.document, (node) => {
    if (node?.name) names.add(node.name);
  });
  return names;
}

export function validateDesignSystem({ fileBody, variablesBody, foundationResult, typographyResult, componentsResult }) {
  const issues = [];
  const warnings = [];

  const pageNames = findPageNames(fileBody);
  const nodeNames = summarizeNodes(fileBody);
  const expectedPages = FOUNDATION_PAGES;

  for (const page of expectedPages) {
    if (!pageNames.some((p) => p === page || p.startsWith("10 Screens - ") && page === "10 Screens - Project")) {
      issues.push(`Missing page: ${page}`);
    }
  }

  const variableCollections = variablesBody?.meta?.variableCollections || {};
  const variables = variablesBody?.meta?.variables || {};
  const hasTokensCollection = Object.values(variableCollections).some((c) => c?.name === "Tokens");
  if (!hasTokensCollection) issues.push("Missing variable collection: Tokens");

  const varNames = new Set(Object.values(variables).map((v) => v?.name).filter(Boolean));
  const requiredSemantic = [
    "semantic/bg",
    "semantic/fg",
    "semantic/brand",
    "semantic/accent",
  ];
  for (const token of requiredSemantic) {
    if (!varNames.has(token)) warnings.push(`Missing semantic token: ${token}`);
  }

  for (const style of TYPOGRAPHY_SPECS) {
    if (!nodeNames.has(style.name)) {
      warnings.push(`Typography style not found in file structure: ${style.name}`);
    }
  }

  for (const component of COMPONENT_SPECS) {
    if (![...nodeNames].some((n) => n === component.name || n.startsWith(`${component.name} /`))) {
      warnings.push(`Component not found in file structure: ${component.name}`);
    }
  }

  if (!foundationResult?.ok) warnings.push("Foundation writer did not confirm success.");
  if (!typographyResult?.ok) warnings.push("Typography writer did not confirm success.");
  if (!componentsResult?.ok) warnings.push("Component writer did not confirm success.");

  const status = issues.length ? "fail" : warnings.length ? "warn" : "pass";
  return {
    status,
    issues,
    pagesFound: pageNames,
    variableCount: Object.keys(variables).length,
    warnings,
  };
}
