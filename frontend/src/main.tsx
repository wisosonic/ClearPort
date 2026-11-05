import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './i18n';
import './styles/index.css';
import { App } from './app/App';
import { applyAppearance } from './lib/appearance';

applyAppearance();

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
