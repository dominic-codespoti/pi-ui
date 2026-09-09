declare global {
  namespace App {
    interface PageState {
      /**
       * Mobile drawer marker — pushed via shallow navigation while a session
       * or right panel drawer is open so Android back pops it (the popstate
       * listener closes the drawer instead of leaving the app).
       */
      piUiDrawer?: boolean;
      /**
       * Path this app optimistically wrote into `?session=` during a switch.
       * Present means the URL is app-owned (not a user deep link), so boot
       * resolution prefers the stored last-session identity over a stale URL.
       */
      piUiOptimisticSession?: string | null;
    }
  }
}

export {};
