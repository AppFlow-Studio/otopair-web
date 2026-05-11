/**
 * Global error handling: errorBus + ErrorModalHost.
 * Errors are logged (to Convex via console interceptor) and shown in a modal.
 */

import React, { Component, type ReactNode } from "react";
import { useRouter } from "expo-router";
import { ErrorOccurredModal } from "@/components/shared-ui";

export type ErrState = { error?: unknown; visible: boolean };

const listeners: Array<() => void> = [];

export const errorBus: {
  state: ErrState;
  set: (s: Partial<ErrState>) => void;
} = {
  state: { visible: false },
  set(s) {
    Object.assign(this.state, s);
    listeners.forEach((l) => l());
  },
};

export function ErrorModalHost() {
  const router = useRouter();
  const [state, setState] = React.useState<ErrState>(() => ({ ...errorBus.state }));

  React.useEffect(() => {
    const sync = () => setState({ ...errorBus.state });
    listeners.push(sync);
    return () => {
      const i = listeners.indexOf(sync);
      if (i >= 0) listeners.splice(i, 1);
    };
  }, []);

  const message =
    state.error instanceof Error
      ? state.error.message
      : state.error != null
        ? String(state.error)
        : "Something went wrong. Please try again.";

  const handleClose = () => errorBus.set({ visible: false, error: undefined });
  const handleGoHome = () => {
    errorBus.set({ visible: false, error: undefined });
    router.replace("/");
  };

  return (
    <ErrorOccurredModal
      visible={state.visible}
      title="Something went wrong"
      message={message}
      onClose={handleClose}
      onRetry={handleGoHome}
      inline
    />
  );
}

interface Props {
  children: ReactNode;
}

interface State {
  err: unknown;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { err: null };

  static getDerivedStateFromError(err: unknown): Partial<State> {
    return { err };
  }

  componentDidCatch(err: unknown) {
    console.error(err);
    errorBus.set({ visible: true, error: err });
  }

  render() {
    return this.props.children;
  }
}
