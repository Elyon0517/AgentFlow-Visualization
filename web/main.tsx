import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { FlowView } from './components/agent-visualizer/flow-view'
import './app/globals.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <FlowView />
  </StrictMode>,
)
