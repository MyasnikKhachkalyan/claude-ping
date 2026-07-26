import { existsSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
// `.git` is a directory in a normal clone and a file in a worktree or submodule; existsSync
// covers both, so worktrees report the repo they belong to rather than their own folder name.
export function gitRoot(start) {
    let dir = resolve(start);
    for (;;) {
        if (existsSync(join(dir, '.git')))
            return dir;
        const parent = dirname(dir);
        if (parent === dir)
            return null;
        dir = parent;
    }
}
// The repo is what identifies the work — a bare directory name like "src" or "app" tells you
// nothing when several projects report into the same chat. Sub-path is kept so nested packages
// stay distinguishable.
export function repoLabel(cwd) {
    if (!cwd)
        return 'claude';
    const root = gitRoot(cwd);
    if (!root)
        return basename(cwd) || 'claude';
    const repo = basename(root);
    const rel = relative(root, resolve(cwd));
    return rel ? `${repo}/${rel}` : repo;
}
/** The key per-repo settings are stored under: the repo root, or the directory itself. */
export function repoKey(cwd) {
    if (!cwd)
        return null;
    return gitRoot(cwd) ?? resolve(cwd);
}
//# sourceMappingURL=repo.js.map