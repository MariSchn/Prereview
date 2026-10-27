import * as vscode from 'vscode';
import { Controller } from './controller';

export async function activate(context: vscode.ExtensionContext): Promise<Controller> {
  const controller = new Controller(context);
  context.subscriptions.push(controller);
  await controller.restored;
  return controller;
}
