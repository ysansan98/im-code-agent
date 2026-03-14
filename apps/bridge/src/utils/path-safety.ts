export function isPathWithinWorkspace(candidatePath: string, workspacePath: string): boolean {
  return candidatePath === workspacePath || candidatePath.startsWith(`${workspacePath}/`);
}
