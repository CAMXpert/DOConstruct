const basePermissions = Object.freeze({ readFiles: true, writeFiles: true, allowCommands: false, allowedPaths: Object.freeze(['.']) });
const fail = message => Object.assign(new Error(message), { code: 'AI_PERMISSIONS' });

function relativePath(value, { root = false } = {}) {
  if (typeof value !== 'string' || value.includes('\0')) throw fail('工作范围必须是工作区内的相对文件或目录。');
  const slashes = value.replaceAll('\\', '/');
  if ((!slashes && !root) || slashes.startsWith('/') || slashes.includes(':'))
    throw fail('工作范围不能是绝对路径、盘符或空路径。');
  const parts = slashes.split('/');
  if (parts.includes('..')) throw fail('工作范围不能使用 .. 离开或回溯目录。');
  const normalized = parts.filter(part => part && part !== '.').join('/');
  return normalized || '.';
}

function normalizePermissions(input = {}, defaults = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !defaults || typeof defaults !== 'object' || Array.isArray(defaults))
    throw fail('权限设置必须是对象。');
  const permissions = {};
  for (const key of ['readFiles', 'writeFiles', 'allowCommands']) {
    const value = input[key] === undefined ? (defaults[key] === undefined ? basePermissions[key] : defaults[key]) : input[key];
    if (typeof value !== 'boolean') throw fail(`${key} 必须为 true 或 false。`);
    permissions[key] = value;
  }
  const allowedPaths = input.allowedPaths === undefined ? (defaults.allowedPaths === undefined ? basePermissions.allowedPaths : defaults.allowedPaths) : input.allowedPaths;
  if (!Array.isArray(allowedPaths)) throw fail('allowedPaths 必须是相对路径数组；空数组表示没有可访问文件。');
  const seen = new Set();
  permissions.allowedPaths = allowedPaths.map(value => relativePath(value)).filter(value => {
    const key = value.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
  if (permissions.allowCommands && (!permissions.readFiles || !permissions.writeFiles || !permissions.allowedPaths.includes('.')))
    throw fail('执行命令需要启用文件读取和写入，并将工作范围设为整个工作区（.）；命令以当前系统用户权限运行，不能受限于文件工具的局部范围。');
  return permissions;
}

function pathAllowed(relative, permissions, { navigation = false } = {}) {
  try {
    const target = relativePath(relative, { root: true }).toLowerCase();
    if (!Array.isArray(permissions?.allowedPaths)) return false;
    return permissions.allowedPaths.some(value => {
      const allowed = relativePath(value).toLowerCase();
      return allowed === '.' || target === allowed || target.startsWith(allowed + '/') ||
        (navigation && (target === '.' || allowed.startsWith(target + '/')));
    });
  } catch { return false; }
}

function toolAllowed(name, permissions) {
  if (name === 'inspect_project') return true;
  if (['list_files', 'read_file', 'validate_project'].includes(name)) return permissions?.readFiles === true;
  if (['write_file', 'update_outline'].includes(name)) return permissions?.writeFiles === true;
  if (['run_project_command', 'run_shell_command'].includes(name)) return permissions?.allowCommands === true &&
    permissions?.readFiles === true && permissions?.writeFiles === true && permissions?.allowedPaths?.includes('.') === true;
  return false;
}

module.exports = { normalizePermissions, pathAllowed, toolAllowed };
