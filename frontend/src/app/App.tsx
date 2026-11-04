import { useMemo } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider, type createBrowserRouter } from 'react-router-dom';
import { ApiError } from '@/lib/api-client';
import { AuthProvider } from '@/features/auth/auth';
import { createRouter } from './router';

export function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        // never retry a refusal; retry transient failures once
        retry: (count, e) => !(e instanceof ApiError && e.status >= 400 && e.status < 500) && count < 1,
      },
    },
  });
}

export function App({ router, client }: { router?: ReturnType<typeof createBrowserRouter>; client?: QueryClient }) {
  const qc = useMemo(() => client ?? makeQueryClient(), [client]);
  const r = useMemo(() => router ?? createRouter(), [router]);
  return (
    <QueryClientProvider client={qc}>
      <AuthProvider><RouterProvider router={r} /></AuthProvider>
    </QueryClientProvider>
  );
}
