// Client ==> Qadam Flow
// Vendor ==> Customers using our embed sdk
export enum QadamFlowClientEventName {
  CLIENT_INIT = 'CLIENT_INIT',
  CLIENT_ROUTE_CHANGED = 'CLIENT_ROUTE_CHANGED',
  CLIENT_NEW_CONNECTION_DIALOG_CLOSED = 'CLIENT_NEW_CONNECTION_DIALOG_CLOSED',
  CLIENT_SHOW_CONNECTION_IFRAME = 'CLIENT_SHOW_CONNECTION_IFRAME',
  CLIENT_CONNECTION_NAME_IS_INVALID = 'CLIENT_CONNECTION_NAME_IS_INVALID',
  CLIENT_AUTHENTICATION_SUCCESS = 'CLIENT_AUTHENTICATION_SUCCESS',
  CLIENT_AUTHENTICATION_FAILED = 'CLIENT_AUTHENTICATION_FAILED',
  CLIENT_CONFIGURATION_FINISHED = 'CLIENT_CONFIGURATION_FINISHED',
  CLIENT_CONNECTION_PIECE_NOT_FOUND = 'CLIENT_CONNECTION_PIECE_NOT_FOUND',
  CLIENT_BUILDER_HOME_BUTTON_CLICKED = 'CLIENT_BUILDER_HOME_BUTTON_CLICKED',
}

export enum QadamFlowVendorEventName {
  VENDOR_INIT = 'VENDOR_INIT',
  VENDOR_ROUTE_CHANGED = 'VENDOR_ROUTE_CHANGED',
}

export interface QadamFlowClientInit {
  type: QadamFlowClientEventName.CLIENT_INIT;
  data: Record<string, never>;
}

export interface QadamFlowClientAuthenticationSuccess {
  type: QadamFlowClientEventName.CLIENT_AUTHENTICATION_SUCCESS;
  data: Record<string, never>;
}

export interface QadamFlowClientAuthenticationFailed {
  type: QadamFlowClientEventName.CLIENT_AUTHENTICATION_FAILED;
  data: unknown;
}

// Added this event so in the future if we add another step between authentication and configuration finished, we can use this event to notify the parent
export interface QadamFlowClientConfigurationFinished {
  type: QadamFlowClientEventName.CLIENT_CONFIGURATION_FINISHED;
  data: Record<string, never>;
}

export interface QadamFlowClientShowConnectionIframe {
  type: QadamFlowClientEventName.CLIENT_SHOW_CONNECTION_IFRAME;
  data: Record<string, never>;
}

export interface QadamFlowClientConnectionNameIsInvalid {
  type: QadamFlowClientEventName.CLIENT_CONNECTION_NAME_IS_INVALID;
  data: {
    error: string;
  };
}

export interface QadamFlowClientConnectionPieceNotFound {
  type: QadamFlowClientEventName.CLIENT_CONNECTION_PIECE_NOT_FOUND;
  data: {
    error: string;
  };
}

export interface QadamFlowClientRouteChanged {
  type: QadamFlowClientEventName.CLIENT_ROUTE_CHANGED;
  data: {
    route: string;
  };
}

export interface QadamFlowNewConnectionDialogClosed {
  type: QadamFlowClientEventName.CLIENT_NEW_CONNECTION_DIALOG_CLOSED;
  data: { connection?: { id: string; name: string } };
}

export interface QadamFlowBuilderHomeButtonClicked {
  type: QadamFlowClientEventName.CLIENT_BUILDER_HOME_BUTTON_CLICKED;
  data: {
    route: string;
  };
}

export interface QadamFlowVendorRouteChanged {
  type: QadamFlowVendorEventName.VENDOR_ROUTE_CHANGED;
  data: {
    vendorRoute: string;
  };
}

export interface QadamFlowVendorInit {
  type: QadamFlowVendorEventName.VENDOR_INIT;
  data: {
    hideSidebar: boolean;
    hideFlowNameInBuilder?: boolean;
    disableNavigationInBuilder: boolean | 'keep_home_button_only';
    hideFolders?: boolean;
    hideTables?: boolean;
    sdkVersion?: string;
    jwtToken: string;
    initialRoute?: string;
    fontUrl?: string;
    fontFamily?: string;
    hideExportAndImportFlow?: boolean;
    hideDuplicateFlow?: boolean;
    homeButtonIcon?: 'back' | 'logo';
    emitHomeButtonClickedEvent?: boolean;
    locale?: string;
    mode?: 'light' | 'dark';
    hideFlowsPageNavbar?: boolean;
    hidePageHeader?: boolean;
  };
}

export type QadamFlowClientEvent =
  | QadamFlowClientInit
  | QadamFlowClientRouteChanged;

export const NEW_CONNECTION_QUERY_PARAMS = {
  name: 'qadamName',
  connectionName: 'connectionName',
  randomId: 'randomId',
};

export const STEP_SETTINGS_QUERY_PARAMS = {
  stepName: 'stepName',
  flowVersionId: 'flowVersionId',
  flowId: 'flowId',
};
