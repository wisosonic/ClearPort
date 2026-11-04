import { useTranslation } from 'react-i18next';
import { can } from '@/lib/permissions';
import { useAuth } from '@/features/auth/auth';
import { TaskList } from './TaskList';

export function TasksPage() {
  const { t } = useTranslation();
  const { permissions } = useAuth();
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">{t('tasks.title')}</h1>
      <TaskList defaultMine={!can(permissions, 'tasks.manage')} />
    </div>
  );
}
