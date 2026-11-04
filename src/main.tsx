/**
 * AQUAPLANT React Entry Point
 * 
 * - Imports React 19 Client DOM root builder (`createRoot`).
 * - Mounts the primary `App` component into `<div id="root"></div>` located in `index.html`.
 * - Injects the global Tailwind stylesheet (`index.css`) containing all utility design tokens.
 */
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';

// Mount the AQUAPLANT Web Application to the DOM container
createRoot(document.getElementById('root')!).render(<App />);
