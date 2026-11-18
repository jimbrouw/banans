import { StrictMode } from 'react'
import * as ReactDOM from 'react-dom'
import './index.css'
import App from './App.tsx'
import { registerUxpEntrypoints } from './hostRuntime'

let mounted = false
const renderApp = () => {
  if (mounted) return
  let container = document.getElementById('root')
  if (!container) {
    container = document.createElement('div')
    container.id = 'root'
    document.body.appendChild(container)
  }
  mounted = true
  ReactDOM.render(
    <StrictMode>
      <App />
    </StrictMode>,
    container,
  )
}

registerUxpEntrypoints(renderApp)
renderApp()
