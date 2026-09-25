import { fileURLToPath } from 'node:url';
import * as fs from 'fs/promises';
import path from 'path';
import logger from '../logger.js';

const modulePromptManagerDir = path.dirname(fileURLToPath(import.meta.url));
const MODULES_DIRECTORY = path.resolve(modulePromptManagerDir, '..', '..', 'docs', 'Modules');
const MAX_MODULE_SUGGESTIONS = 6;

export interface ModulePrompt {
  title: string;
  body: string;
  module: string;
  slug: string;
}

function normalizeModuleFileName(moduleName: string): string {
  const trimmed = moduleName.trim();

  if (trimmed.includes('..') || trimmed.includes('/') || trimmed.includes('\\')) {
    throw new Error(`Invalid module name: ${moduleName}`);
  }

  return trimmed.toLowerCase().endsWith('.md') ? trimmed : `${trimmed}.md`;
}

export function getPromptSlug(title: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');

  return base.length > 0 ? base : `prompt-${Date.now()}`;
}

async function resolveModuleFile(
  moduleName: string
): Promise<{ fileName: string; modulePath: string }> {
  const normalizedModuleName = normalizeModuleFileName(moduleName);

  let entries: string[];
  try {
    entries = await fs.readdir(MODULES_DIRECTORY);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Modules directory not found at ${MODULES_DIRECTORY}. Ensure AutoHotkey documentation modules are installed. (${reason})`
    );
  }

  const match = entries.find(entry => entry.toLowerCase() === normalizedModuleName.toLowerCase());
  if (!match) {
    const suggestions = entries
      .filter(entry => entry.toLowerCase().endsWith('.md'))
      .sort((a, b) => a.localeCompare(b))
      .slice(0, MAX_MODULE_SUGGESTIONS)
      .join(', ');
    const hint = suggestions
      ? `Available modules include: ${suggestions}`
      : 'No module files were found in the modules directory.';
    throw new Error(`Module file not found: ${normalizedModuleName}. ${hint}`);
  }

  return {
    fileName: match,
    modulePath: path.join(MODULES_DIRECTORY, match),
  };
}

function getModuleDisplayName(fileName: string): string {
  const withoutExtension = fileName.replace(/\.md$/i, '').replace(/^Module_/i, '');
  const display = withoutExtension
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!display) {
    return 'AutoHotkey';
  }

  if (display.toLowerCase() === 'instructions') {
    return 'AutoHotkey';
  }

  return display;
}

export async function insertPromptIntoModule(
  moduleName: string,
  prompt: { title: string; body: string }
): Promise<ModulePrompt> {
  const { fileName: moduleFileName, modulePath } = await resolveModuleFile(moduleName);

  let existingContent: string;
  try {
    existingContent = await fs.readFile(modulePath, 'utf8');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read module file ${moduleFileName}: ${reason}`);
  }

  const slug = getPromptSlug(prompt.title);
  const startMarker = `<!-- BEGIN AHK PROMPT: ${slug} -->`;
  const endMarker = `<!-- END AHK PROMPT: ${slug} -->`;

  if (existingContent.includes(startMarker)) {
    throw new Error(`Prompt "${prompt.title}" already exists in ${moduleFileName}`);
  }

  const normalizedBody = prompt.body.trim().replace(/\r\n/g, '\n');
  const promptBlock = [
    '',
    startMarker,
    `### ${prompt.title.trim()}`,
    normalizedBody,
    endMarker,
    '',
  ].join('\n');

  const updatedContent = `${existingContent.trimEnd()}${promptBlock}`;
  const finalContent = updatedContent.endsWith('\n') ? updatedContent : `${updatedContent}\n`;

  await fs.writeFile(modulePath, finalContent, 'utf8');
  logger.info(`Inserted prompt "${prompt.title}" into ${moduleFileName}`);

  return {
    title: prompt.title.trim(),
    body: normalizedBody,
    module: moduleFileName,
    slug,
  };
}

function extractCommentPrompts(content: string, fileName: string): ModulePrompt[] {
  const prompts: ModulePrompt[] = [];
  const promptBlockRegex =
    /<!-- BEGIN AHK PROMPT: ([a-z0-9-]+) -->([\s\S]*?)<!-- END AHK PROMPT: \1 -->/gi;

  let match: RegExpExecArray | null;
  while ((match = promptBlockRegex.exec(content)) !== null) {
    const slug = match[1];
    const rawBlock = match[2].trim().replace(/\r\n/g, '\n');
    const lines = rawBlock.split('\n');

    let title = slug;
    let body = rawBlock;

    if (lines.length > 0 && lines[0].startsWith('###')) {
      title = lines[0].replace(/^###\s*/, '').trim() || slug;
      body = lines.slice(1).join('\n').trim();
    }

    prompts.push({
      title,
      body,
      module: fileName,
      slug,
    });
  }

  return prompts;
}

function extractXmlPrompts(content: string, fileName: string): ModulePrompt[] {
  const prompts: ModulePrompt[] = [];
  const displayName = getModuleDisplayName(fileName);

  const xmlPromptConfigs = [
    {
      tag: 'AHK_AGENT_INSTRUCTION',
      titleBuilder: (index: number) =>
        `${displayName} Agent Instruction${index > 1 ? ` ${index}` : ''}`,
    },
    {
      tag: 'METAPROMPT_AGENT_INSTRUCTION',
      titleBuilder: (index: number) => `${displayName} Meta Prompt${index > 1 ? ` ${index}` : ''}`,
    },
  ];

  for (const config of xmlPromptConfigs) {
    const regex = new RegExp(`<${config.tag}>([\\s\\S]*?)</${config.tag}>`, 'gi');
    let match: RegExpExecArray | null;
    let localIndex = 0;

    while ((match = regex.exec(content)) !== null) {
      const body = (match[1] || '').trim().replace(/\r\n/g, '\n');
      if (!body) {
        continue;
      }

      localIndex += 1;
      const title = config.titleBuilder(localIndex);
      const slug = getPromptSlug(`${title}-${fileName}-${localIndex}`);

      prompts.push({
        title,
        body,
        module: fileName,
        slug,
      });
    }
  }

  return prompts;
}

export async function loadPromptsFromModules(): Promise<ModulePrompt[]> {
  let moduleFiles: string[];
  try {
    moduleFiles = await fs.readdir(MODULES_DIRECTORY);
  } catch (error) {
    logger.warn(`Unable to read modules directory: ${MODULES_DIRECTORY}`, error);
    return [];
  }

  const prompts: ModulePrompt[] = [];

  for (const fileName of moduleFiles) {
    if (!fileName.toLowerCase().endsWith('.md')) {
      continue;
    }

    const modulePath = path.join(MODULES_DIRECTORY, fileName);

    let content: string;
    try {
      content = await fs.readFile(modulePath, 'utf8');
    } catch (error) {
      logger.warn(`Unable to read module file ${fileName}`, error);
      continue;
    }

    prompts.push(...extractCommentPrompts(content, fileName));
    prompts.push(...extractXmlPrompts(content, fileName));
  }

  return prompts;
}
