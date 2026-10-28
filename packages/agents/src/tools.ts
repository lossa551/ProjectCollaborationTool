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
export const RecordTestResultInput = z.object({
  criterion_id: z.string().min(1),
  result: z.enum(['verified', 'failing']),
  evidence: z.string().min(1).max(4000),
});

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
  {
    name: 'record_test_result',
    description:
      'Record whether one of the task’s acceptance criteria is met, after you checked it. Everyone in the session sees the result on the task.',
    schema: object(
      {
        criterion_id: { type: 'string', description: 'The id in square brackets in the task’s acceptance criteria.' },
        result: { type: 'string', enum: ['verified', 'failing'] },
        evidence: { type: 'string', description: 'What you checked and what happened, e.g. the test command and its outcome.' },
      },
      ['criterion_id', 'result', 'evidence'],
    ),
  },
];

export const RunTestsInput = z.object({ target: z.string().max(500).optional() });

/**
 * Offered when the app can run the game's tests: a Godot project with a test
 * add-on (GUT or gdUnit4) and Godot's path known, or an Unreal project with
 * Unreal Engine found on this PC.
 */
export function runTestsTool(engine: 'godot' | 'unreal'): ToolSpec {
  if (engine === 'unreal') {
    return {
      name: 'run_tests',
      description:
        'Run the project’s Unreal automation tests headless (UnrealEditor-Cmd, no rendering) and get a summary: passing, failing and ' +
        'which tests failed. Takes minutes. Use the result as evidence for record_test_result. May need a person’s approval, like a command.',
      schema: object(
        { target: { type: 'string', description: 'A test name prefix, e.g. Project.Combat; leave out for every test under Project.' } },
        [],
      ),
    };
  }
  return {
    name: 'run_tests',
    description:
      'Run the game’s tests headless in Godot (GUT or gdUnit4) and get a summary: passing, failing and which tests failed. ' +
      'Use the result as evidence for record_test_result. May need a person’s approval, like a command.',
    schema: object(
      { target: { type: 'string', description: 'A res:// test folder or test script; leave out for all tests.' } },
      [],
    ),
  };
}
