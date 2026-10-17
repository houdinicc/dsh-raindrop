/**
 * 按 Harness `@deepseek-ai/dsh-tools` 的 enforced JSON Schema 子集校验工具 schema。
 * 仅用于本地预检（不依赖 @deepseek-ai 包），避免装完重启后才发现 register() 抛错。
 *
 * 子集规则（摘自 dsh-tools lib/index.js）：
 *  - 只允许 type / oneOf / properties / required / additionalProperties / items / enum / const
 *    + 注解 description / title / default / examples；
 *  - type 必须是单个字符串（不允许 type 数组）；
 *  - oneOf 至少 2 个分支，且不能和 properties/required/additionalProperties/items/enum/const 并列；
 *  - required 里的名字必须在 properties 中声明；
 *  - enum / const 必须与 type 匹配。
 */
const SCHEMA_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'];
const CONSTRAINT = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const']);
const ANNOTATION = new Set(['description', 'title', 'default', 'examples']);
const ONE_OF_SIBLINGS = ['properties', 'required', 'additionalProperties', 'items', 'enum', 'const'];

const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

export function checkSchema(schema, path = 'schema', errors = []) {
  if (!isRecord(schema)) {
    errors.push(`${path} must be a schema object`);
    return errors;
  }
  for (const key of Object.keys(schema)) {
    if (CONSTRAINT.has(key) || ANNOTATION.has(key)) continue;
    errors.push(`${path}.${key} is not a supported keyword`);
  }
  const hasType = Object.hasOwn(schema, 'type');
  const hasOneOf = Object.hasOwn(schema, 'oneOf');
  if (hasType && hasOneOf) {
    errors.push(`${path} cannot declare both type and oneOf`);
    return errors;
  }
  if (hasOneOf) {
    if (!Array.isArray(schema.oneOf) || schema.oneOf.length < 2) {
      errors.push(`${path}.oneOf must be an array of at least two schemas`);
    } else {
      schema.oneOf.forEach((entry, index) => checkSchema(entry, `${path}.oneOf[${index}]`, errors));
    }
    for (const key of ONE_OF_SIBLINGS) {
      if (Object.hasOwn(schema, key)) errors.push(`${path}.${key} is not supported beside oneOf`);
    }
    return errors;
  }
  if (!hasType) {
    for (const key of ONE_OF_SIBLINGS) {
      if (Object.hasOwn(schema, key)) errors.push(`${path}.${key} requires type or oneOf`);
    }
    return errors;
  }
  if (typeof schema.type !== 'string' || !SCHEMA_TYPES.includes(schema.type)) {
    errors.push(Array.isArray(schema.type)
      ? `${path}.type must be a single type string (type arrays are not supported)`
      : `${path}.type must be one of ${SCHEMA_TYPES.join('/')}`);
    return errors;
  }
  if (Object.hasOwn(schema, 'properties')) {
    if (schema.type !== 'object') errors.push(`${path}.properties is not supported on type "${schema.type}"`);
    if (!isRecord(schema.properties)) errors.push(`${path}.properties must be an object of schemas`);
    else for (const [key, value] of Object.entries(schema.properties)) checkSchema(value, `${path}.properties.${key}`, errors);
  }
  if (Object.hasOwn(schema, 'required')) {
    if (schema.type !== 'object') errors.push(`${path}.required is not supported on type "${schema.type}"`);
    if (!Array.isArray(schema.required) || schema.required.some((entry) => typeof entry !== 'string')) {
      errors.push(`${path}.required must be an array of strings`);
    } else if (isRecord(schema.properties)) {
      for (const key of schema.required) {
        if (!Object.hasOwn(schema.properties, key)) errors.push(`${path}.required names "${key}" which is not in properties`);
      }
    }
  }
  if (Object.hasOwn(schema, 'additionalProperties') && typeof schema.additionalProperties !== 'boolean') {
    errors.push(`${path}.additionalProperties must be a boolean`);
  }
  if (Object.hasOwn(schema, 'items')) {
    if (schema.type !== 'array') errors.push(`${path}.items is not supported on type "${schema.type}"`);
    checkSchema(schema.items, `${path}.items`, errors);
  }
  return errors;
}
