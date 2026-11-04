import { useQueryClient } from '@tanstack/react-query';

/** Everything that shows tasks, or that depends on them (open tasks can block a stage move or closing the file). */
export function useRefreshTasks(fileId?: string) {
  const qc = useQueryClient();
  return () => Promise.all([
    qc.invalidateQueries({ queryKey: ['tasks'] }),
    qc.invalidateQueries({ queryKey: ['dashboard'] }),
    ...(fileId ? [
      qc.invalidateQueries({ queryKey: ['file-transitions', fileId] }),
      qc.invalidateQueries({ queryKey: ['file-closure', fileId] }),
      qc.invalidateQueries({ queryKey: ['file-summary', fileId] }),
      qc.invalidateQueries({ queryKey: ['file-timeline', fileId] }),
    ] : []),
  ]);
}
