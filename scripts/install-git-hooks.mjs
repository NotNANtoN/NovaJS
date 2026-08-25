import {
    chmodSync,
    copyFileSync,
    existsSync,
    mkdirSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '..',
);
const hookNames = ['pre-commit', 'pre-push'];

export function installGitHooks({
    root = repositoryRoot,
    gitDir,
    dryRun = false,
} = {}) {
    let resolvedGitDir = gitDir;
    if (!resolvedGitDir) {
        try {
            resolvedGitDir = execFileSync(
                'git',
                ['rev-parse', '--git-dir'],
                { cwd: root, encoding: 'utf8' },
            ).trim();
        } catch {
            console.log('Skipping Git hooks: no Git worktree found.');
            return [];
        }
    }
    resolvedGitDir = isAbsolute(resolvedGitDir)
        ? resolvedGitDir
        : resolve(root, resolvedGitDir);
    const hooksDir = resolve(resolvedGitDir, 'hooks');
    const installed = [];
    for (const hookName of hookNames) {
        const source = resolve(root, '.githooks', hookName);
        const destination = resolve(hooksDir, hookName);
        if (!existsSync(source)) {
            throw new Error(`Missing checked-in hook: ${source}`);
        }
        installed.push(destination);
        if (!dryRun) {
            mkdirSync(hooksDir, { recursive: true });
            copyFileSync(source, destination);
            chmodSync(destination, 0o755);
        }
    }
    console.log(`${dryRun ? 'Would install' : 'Installed'} Git hooks: ${
        installed.join(', ')}`);
    return installed;
}

function optionValue(name) {
    const index = process.argv.indexOf(name);
    if (index >= 0) {
        return process.argv[index + 1];
    }
    const prefix = `${name}=`;
    return process.argv.find(argument => argument.startsWith(prefix))
        ?.slice(prefix.length);
}

if (process.argv[1]
    && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    installGitHooks({
        gitDir: optionValue('--git-dir'),
        dryRun: process.argv.includes('--dry-run'),
    });
}
