import { z } from 'zod';
import type { ToolSpec } from './models/types.js';

// The tools our own agent loop gives a model. Reading is always allowed;
// writing and commands go through the guard first (see runner.ts).

export const ReadFileInput = z.object({
  path: z.string().min(1),
  offset: z.number().int().min(1).optional(),
  limit: z.number().int().min(1).max(5000).optional(),
});
export const ListFilesInput = z.object({ path: z.string().optional() });
export const SearchInput = z.object({ pattern: z.string().min(1), path: z.string().optional() });
export const WriteFileInput = z.object({ path: z.string().min(1), content: z.string() });
export const EditFileInput = z.object({ path: z.string().min(1), old_text: z.string().min(1), new_text: z.string() });
export const RunCommandInput = z.object({ command: z.string().min(1).max(4000) });

const object = (properties: Record<string, unknown>, required: string[]) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

export const AGENT_TOOLS: ToolSpec[] = [
  {
    name: 'list_files',
    description: 'List files in the project (or under a folder), as git sees them. Paths are relative to the repository root.',
    schema: object({ path: { type: 'string', description: 'Folder to list; leave out for the whole project.' } }, []),
  },
  {
    name: 'read_file',
    description: 'Read a text file with line numbers. Use offset and limit for long files.',
    schema: object(
      {
        path: { type: 'string', description: 'Repo-relative path, forward slashes.' },
        offset: { type: 'integer', description: 'First line to read, from 1.' },
        limit: { type: 'integer', description: 'How many lines to read (default 2000).' },
      },
      ['path'],
    ),
  },
  {
    name: 'search',
    description: 'Search file contents with a regular expression (git grep). Returns matching lines with file and line number.',
    schema: object(
      { pattern: { type: 'string' }, path: { type: 'string', description: 'Limit the search to this folder or file.' } },
      ['pattern'],
    ),
  },
  {
    name: 'write_file',
    description:
      'Create or overwrite a file with the full content given. The app checks file locks, the task’s allowed paths and approvals first; if it answers that the edit is blocked, do not try another way around it.',
    schema: object({ path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']),
  },
  {
    name: 'edit_file',
    description:
      'Replace one exact piece of text in a file. old_text must occur exactly once; include enough surrounding lines to make it unique. Checked like write_file.',
    schema: object({ path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' } }, ['path', 'old_text', 'new_text']),
  },
  {
    name: 'run_command',
    description:
      'Run a shell command in the project folder (for example the tests or a build) and get its output. May need a person’s approval. Times out after two minutes.',
    schema: object({ command: { type: 'string' } }, ['command']),
  },
];
