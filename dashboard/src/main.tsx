import { createRoot } from 'react-dom/client'
import { ApiError } from './api'
import App from './App'
import './styles.css'

// Views fire several requests at once; when the daemon answers 401 they all reject, and App shows the key panel instead.
window.addEventListener('unhandledrejection', e => { if (e.reason instanceof ApiError && e.reason.code === 'unauthorized') e.preventDefault() })

createRoot(document.getElementById('root')!).render(<App />)
