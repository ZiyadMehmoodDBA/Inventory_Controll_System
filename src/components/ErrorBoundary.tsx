import { Component, type ReactNode } from 'react';

interface Props { children: ReactNode; onClose?: () => void; label?: string }
interface State { error: Error | null }

// Keeps a failure inside one panel from unmounting the whole app (a blank screen that lands on the dashboard after reload).
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };
  static getDerivedStateFromError(error: Error): State { return { error }; }
  componentDidCatch(error: Error) { console.error(`${this.props.label ?? 'Panel'} crashed:`, error); }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-2xl max-w-sm w-full p-6 text-center">
          <h3 className="text-sm font-bold text-slate-900">Something went wrong</h3>
          <p className="text-xs text-slate-500 mt-1">{this.props.label ?? 'This panel'} could not be displayed. Your data is unchanged.</p>
          <button onClick={() => { this.setState({ error: null }); this.props.onClose?.(); }}
            className="mt-4 px-4 py-2 text-sm font-semibold bg-teal-600 text-white rounded-xl hover:bg-teal-700">Close</button>
        </div>
      </div>
    );
  }
}
