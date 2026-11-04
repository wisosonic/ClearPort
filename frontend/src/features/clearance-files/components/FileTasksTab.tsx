import { TaskList } from '@/features/tasks/TaskList';
import type { FileDetail } from '../lib';

export function FileTasksTab({ file }: { file: FileDetail }) {
  return <TaskList fileId={file.id} locked={file.status === 'CLOSED' || file.status === 'CANCELLED'} />;
}
