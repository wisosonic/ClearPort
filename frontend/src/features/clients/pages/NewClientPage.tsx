import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Card } from '@/components/ui/primitives';
import { ClientForm } from '../components/ClientForm';

export function NewClientPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">{t('clients.createTitle')}</h1>
        <Link to="/clients" className="text-sm text-brand-700 hover:underline">{t('common.back')}</Link>
      </div>
      <Card className="p-5">
        <ClientForm onCancel={() => navigate('/clients')} onSaved={async (c) => { await qc.invalidateQueries({ queryKey: ['clients'] }); navigate(`/clients/${c.id}`); }} />
      </Card>
    </div>
  );
}
