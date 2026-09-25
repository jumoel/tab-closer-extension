export class RuleError extends Error {
  constructor(operation, line) {
    super(`Rule on line ${line} failed during ${operation}.`);
    this.name = 'RuleError';
    this.operation = operation;
    this.line = line;
  }
}

export function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function compileRules(source) {
  const rules = [];
  for (const [index, text] of source.split(/\r?\n/).entries()) {
    if (!text.trim()) continue;
    try {
      rules.push({ line: index + 1, expression: new RegExp(text) });
    } catch {
      throw new RuleError('validation', index + 1);
    }
  }
  return rules;
}

export function matchingLines(rules, url, firstOnly = false) {
  const lines = [];
  for (const rule of rules) {
    let matches;
    try {
      matches = rule.expression.test(url);
    } catch {
      throw new RuleError('matching', rule.line);
    }
    if (matches) {
      lines.push(rule.line);
      if (firstOnly) break;
    }
  }
  return lines;
}
