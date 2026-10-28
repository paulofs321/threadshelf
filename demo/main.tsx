import { createRoot } from 'react-dom/client';
import { DemoApp } from './App';

const root = document.getElementById('root');

if (!root) throw new Error('Missing demo root.');

createRoot(root).render(<DemoApp />);
