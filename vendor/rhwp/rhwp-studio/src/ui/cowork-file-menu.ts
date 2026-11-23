// [hwpx-cowork] Only a same-origin Cowork document tab owns this interface.
// Other embedders keep the original lifecycle restrictions.
import type { CommandDef } from '../command/types';

interface CoworkFiles {
  enabled(cmd: string): boolean;
  run(cmd: string, recentId?: string): void;
  recent(): { id: string; fileName: string; sourceFormat: string }[];
}

export function coworkFrameFiles(): CoworkFiles | undefined {
  return (window.frameElement?.closest('.editorhost') as (HTMLElement & { coworkFiles?: CoworkFiles }) | null)?.coworkFiles;
}

const hostCommands = new Set(['file:new-doc', 'file:open', 'file:open-recent', 'file:clear-recent', 'file:save']);

export function coworkFileCommands(commands: CommandDef[], host: CoworkFiles): CommandDef[] {
  return commands.map(cmd => ({
    ...cmd,
    canExecute: ctx => host.enabled(cmd.id) && (cmd.canExecute?.(ctx) ?? true),
    execute: hostCommands.has(cmd.id)
      ? (_services, params) => host.run(cmd.id, typeof params?.id === 'string' ? params.id : undefined)
      : cmd.execute,
  }));
}
