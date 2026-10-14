import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { SetupScreen } from '../../ui/SetupScreen';
import '../../ui/styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('ThreadShelf root element is missing.');

createRoot(root).render(
  <StrictMode>
    <SetupScreen />
  </StrictMode>,
);
