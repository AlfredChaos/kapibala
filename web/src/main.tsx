import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import './styles/index.css';
import { App } from './App';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('root element #root not found');
}

createRoot(rootElement).render(<App />);
