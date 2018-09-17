// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

/**
 * TODO:
 *
 * - Hook up as an abstract editor? Or at least as another default editor
 * - `monaco.languages.getLanguages()` contains all of the highlighting modes -
 *
 */

const LANGUAGE = "python"

require('monaco-editor-core');

import {
  JupyterLab, JupyterLabPlugin
} from '@jupyterlab/application';


import {
  ICommandPalette
} from '@jupyterlab/apputils';

import {
  PathExt, ISettingRegistry
} from '@jupyterlab/coreutils';

import {
  ABCWidgetFactory, DocumentRegistry, IDocumentWidget, DocumentWidget
} from '@jupyterlab/docregistry';

import {
  IEditorTracker
} from '@jupyterlab/fileeditor';

import {
  UUID, PromiseDelegate
} from '@phosphor/coreutils';

import {
  Widget
} from '@phosphor/widgets';

import '../style/index.css';

import * as monacoCSS from 'file-loader!../lib/css.worker.bundle.js';
import * as monacoEditor from 'file-loader!../lib/editor.worker.bundle.js';
import * as monacoHTML from 'file-loader!../lib/html.worker.bundle.js';
import * as monacoJSON from 'file-loader!../lib/json.worker.bundle.js';
import * as monacoTS from 'file-loader!../lib/ts.worker.bundle.js';

import { getLanguageService, TextDocument } from "vscode-json-languageservice";
import { listen, MessageConnection } from 'vscode-ws-jsonrpc';
import {
    MonacoToProtocolConverter, ProtocolToMonacoConverter,
    MonacoLanguageClient, CloseAction, ErrorAction,
    MonacoServices, createConnection
} from 'monaco-languageclient';

const ReconnectingWebSocket = require('reconnecting-websocket');

let URLS: {[key: string]: string} = {
  css: monacoCSS,
  html: monacoHTML,
  javascript: monacoTS,
  json: monacoJSON,
  typescript: monacoTS
};

(self as any).MonacoEnvironment = {
  getWorkerUrl: function (moduleId: string, label: string): string {
    let url = URLS[label] || monacoEditor;
    return url;
  }
}

function resovleSchema(url: string): Promise<string> {
    const promise = new Promise<string>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.onload = () => resolve(xhr.responseText);
        xhr.onerror = () => reject(xhr.statusText);
        xhr.open("GET", url, true);
        xhr.send();
    });
    return promise;
}

const m2p = new MonacoToProtocolConverter();
const p2m = new ProtocolToMonacoConverter();
const jsonService = getLanguageService({
//  schemaRequestService: resovleSchema
  });
const pendingValidationRequests = new Map<string, number>();

function createDocument(model: monaco.editor.ITextModel) {
    return TextDocument.create(model.uri.toString(), model.getModeId(), model.getVersionId(), model.getValue());
}

function createWebSocket(url: string): WebSocket {
    const socketOptions = {
        maxReconnectionDelay: 10000,
        minReconnectionDelay: 1000,
        reconnectionDelayGrowFactor: 1.3,
        connectionTimeout: 10000,
        maxRetries: Infinity,
        debug: false
    };
    return new ReconnectingWebSocket(url, undefined, socketOptions);
}

// register the Python language with Monaco
monaco.languages.register({
	id: LANGUAGE,
    	extensions: ['.py'],
    	aliases: ['Python', 'PYTHON', 'py'],
    	mimetypes: ['text/plain']
});


/**
* An monaco widget.
*/
export
class MonacoWidget extends Widget {
  /**
   * Construct a new Monaco widget.
   */
  constructor(context: DocumentRegistry.CodeContext, lspServer: string) {
    super();
    this.id = UUID.uuid4();
    this.title.label = PathExt.basename(context.localPath);
    this.title.closable = true;
    this.context = context;

    let content = context.model.toString();
    let uri = monaco.Uri.parse(context.path);

    let monaco_model = undefined;
    if(monaco.editor.getModel(uri)) {
      monaco_model = monaco.editor.getModel(uri);
    } else {
      monaco_model = monaco.editor.createModel(content, LANGUAGE, uri);
    }

    monaco.editor.setModelLanguage(monaco_model, "python");

    this.editor = monaco.editor.create(this.node, {
      model: monaco_model,
      glyphMargin: true,
      lightbulb: {
        enabled: true
      }
    });

    var mm = this.editor.getModel();
    mm.onDidChangeContent((event) => {
      this.context.model.value.text = this.editor.getValue();
    });

    context.ready.then(() => { this._onContextReady(); });

    MonacoServices.install(this.editor);

    function createLanguageClient(connection: MessageConnection): MonacoLanguageClient {
      return new MonacoLanguageClient({
        name: "Sample Language Client",
        clientOptions: {
            // use a language id as a document selector
            documentSelector: [LANGUAGE],
            // disable the default error handler
            errorHandler: {
                error: () => ErrorAction.Continue,
                closed: () => CloseAction.DoNotRestart
            }
        },
        // create a language client connection from the JSON RPC connection on demand
        connectionProvider: {
            get: (errorHandler, closeHandler) => {
                return Promise.resolve(createConnection(connection, errorHandler, closeHandler))
            }
        }
      })
    }

    // create the web socket
    const webSocket = createWebSocket(lspServer);
    // listen when the web socket is opened
    listen({
	webSocket,
    	onConnection:
	  connection => {
            // create and start the language client
            const languageClient = createLanguageClient(connection);
            const disposable = languageClient.start();
            connection.onClose(() => disposable.dispose());
    	   }
    });
  }

  /**
   * Handle actions that should be taken when the context is ready.
   */
  private _onContextReady(): void {
    if (this.isDisposed) {
      return;
    }
    const contextModel = this.context.model;

    // Set the editor model value.
    this.editor.setValue(contextModel.toString());

    // Wire signal connections.
    contextModel.contentChanged.connect(this._onContentChanged, this);

    // Resolve the ready promise.
    this._ready.resolve(undefined);
  }

  /**
   * A promise that resolves when the file editor is ready.
   */
  get ready(): Promise<void> {
    return this._ready.promise;
  }

  /**
   * Handle a change in context model content.
   */
  private _onContentChanged(): void {
    const oldValue = this.editor.getValue();
    const newValue = this.context.model.toString();

    if (oldValue !== newValue) {
      this.editor.setValue(newValue);
    }
  }

  onResize() {
    this.editor.layout();
  }

  onAfterShow() {
    this.editor.layout();
  }

  context: DocumentRegistry.CodeContext;
  private _ready = new PromiseDelegate<void>();
  editor: monaco.editor.IStandaloneCodeEditor;
}


/**
 * A widget factory for editors.
 */
export

class MonacoEditorFactory extends ABCWidgetFactory<IDocumentWidget<MonacoWidget>, DocumentRegistry.ICodeModel> {
  private lspServer: string;
  
  constructor(a: any, b: string) {
    super(a);
    this.lspServer = b;
  }
  
  /**
   * Create a new widget given a context.
   */
  protected createNewWidget(context: DocumentRegistry.CodeContext): IDocumentWidget<MonacoWidget> {
    const content = new MonacoWidget(context, this.lspServer);
    const widget = new DocumentWidget({ content, context });
    return widget;
  }
}

/**
 * Initialization data for the jupyterlab-monaco extension.
 *
 * #### Notes
 * The only reason we depend on the IEditorTracker is so that our docregistry
 * 'defaultFor' runs *after* the file editors defaultFor.
 */
const extension: JupyterLabPlugin<void> = {
  id: 'jupyterlab-monaco:plugin',
  autoStart: true,
  requires: [ISettingRegistry, ICommandPalette, IEditorTracker],
  activate: async (app: JupyterLab, registry: ISettingRegistry, palette: ICommandPalette, editorTracker: IEditorTracker) => {
    const settings = await registry.load(extension.id);
    const server = settings.composite['lspServer'] as string;
    console.log("starting " + extension.id + " with " +  server);

    const factory = new MonacoEditorFactory({
      name: 'Monaco Editor',
      fileTypes: ['*'],
      defaultFor: ['*']
    }, server);
    app.docRegistry.addWidgetFactory(factory);

    // Add an application command
    const command: string = 'monaco:open';
    app.commands.addCommand(command, {
      label: 'Monaco Editor',
      execute: () => {
        let widget = new Widget();
        widget.node.innerHTML = 'Creating new files coming...'
        //let widget = new MonacoWidget();
        app.shell.addToMainArea(widget);

        // Activate the widget
        app.shell.activateById(widget.id);
      }
    });

    // Add the command to the palette.
    palette.addItem({ command, category: 'Monaco' });
  }
};

export default extension;
