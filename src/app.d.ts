declare global {
  namespace App {
    interface PageState {
      /**
       * Mobile drawer marker — pushed via shallow navigation while a session
       * or right panel drawer is open so Android back pops it (the popstate
       * listener closes the drawer instead of leaving the app).
       */
      piUiDrawer?: boolean;
    }
  }
}

export {};
