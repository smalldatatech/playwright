/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as dom from './dom';
import * as frames from './frames';
import * as selectorEvaluatorSource from './generated/selectorEvaluatorSource';
import { helper } from './helper';
import SelectorEvaluator from './injected/selectorEvaluator';
import * as js from './javascript';
import * as types from './types';

const kEvaluatorSymbol = Symbol('evaluator');
type EvaluatorData = {
  promise: Promise<js.JSHandle<SelectorEvaluator>>,
  generation: number,
};

export class Selectors {
  readonly _builtinEngines: Set<string>;
  readonly _engines: Map<string, { source: string, contentScript: boolean }>;
  _generation = 0;

  constructor() {
    // Note: keep in sync with SelectorEvaluator class.
    this._builtinEngines = new Set(['css', 'xpath', 'text', 'id', 'data-testid', 'data-test-id', 'data-test']);
    this._engines = new Map();
  }

  async register(name: string, script: string | Function | { path?: string, content?: string }, options: { contentScript?: boolean } = {}): Promise<void> {
    const { contentScript = false } = options;
    if (!name.match(/^[a-zA-Z_0-9-]+$/))
      throw new Error('Selector engine name may only contain [a-zA-Z0-9_] characters');
    // Note: we keep 'zs' for future use.
    if (this._builtinEngines.has(name) || name === 'zs')
      throw new Error(`"${name}" is a predefined selector engine`);
    const source = await helper.evaluationScript(script, undefined, false);
    if (this._engines.has(name))
      throw new Error(`"${name}" selector engine has been already registered`);
    this._engines.set(name, { source, contentScript });
    ++this._generation;
  }

  private _needsMainContext(parsed: types.ParsedSelector): boolean {
    return parsed.some(({name}) => {
      const custom = this._engines.get(name);
      return custom ? !custom.contentScript : false;
    });
  }

  async _prepareEvaluator(context: dom.FrameExecutionContext): Promise<js.JSHandle<SelectorEvaluator>> {
    let data = (context as any)[kEvaluatorSymbol] as EvaluatorData | undefined;
    if (data && data.generation !== this._generation) {
      data.promise.then(handle => handle.dispose());
      data = undefined;
    }
    if (!data) {
      const custom: string[] = [];
      for (const [name, { source }] of this._engines)
        custom.push(`{ name: '${name}', engine: (${source}) }`);
      const source = `
        new (${selectorEvaluatorSource.source})([
          ${custom.join(',\n')}
        ])
      `;
      data = {
        promise: context._doEvaluateInternal(false /* returnByValue */, false /* waitForNavigations */, source),
        generation: this._generation
      };
      (context as any)[kEvaluatorSymbol] = data;
    }
    return data.promise;
  }

  async _query(frame: frames.Frame, selector: string, scope?: dom.ElementHandle): Promise<dom.ElementHandle<Element> | null> {
    const parsed = this._parseSelector(selector);
    const context = this._needsMainContext(parsed) ? await frame._mainContext() : await frame._utilityContext();
    const handle = await context.evaluateHandleInternal(
        ({ evaluator, parsed, scope }) => evaluator.querySelector(parsed, scope || document),
        { evaluator: await this._prepareEvaluator(context), parsed, scope }
    );
    const elementHandle = handle.asElement() as dom.ElementHandle<Element> | null;
    if (!elementHandle) {
      handle.dispose();
      return null;
    }
    const mainContext = await frame._mainContext();
    if (elementHandle._context === mainContext)
      return elementHandle;
    const adopted = frame._page._delegate.adoptElementHandle(elementHandle, mainContext);
    elementHandle.dispose();
    return adopted;
  }

  async _queryArray(frame: frames.Frame, selector: string, scope?: dom.ElementHandle): Promise<js.JSHandle<Element[]>> {
    const parsed = this._parseSelector(selector);
    const context = await frame._mainContext();
    const arrayHandle = await context.evaluateHandleInternal(
        ({ evaluator, parsed, scope }) => evaluator.querySelectorAll(parsed, scope || document),
        { evaluator: await this._prepareEvaluator(context), parsed, scope }
    );
    return arrayHandle;
  }

  async _queryAll(frame: frames.Frame, selector: string, scope?: dom.ElementHandle, allowUtilityContext?: boolean): Promise<dom.ElementHandle<Element>[]> {
    const parsed = this._parseSelector(selector);
    const context = !allowUtilityContext || this._needsMainContext(parsed) ? await frame._mainContext() : await frame._utilityContext();
    const arrayHandle = await context.evaluateHandleInternal(
        ({ evaluator, parsed, scope }) => evaluator.querySelectorAll(parsed, scope || document),
        { evaluator: await this._prepareEvaluator(context), parsed, scope }
    );
    const properties = await arrayHandle.getProperties();
    arrayHandle.dispose();
    const result: dom.ElementHandle<Element>[] = [];
    for (const property of properties.values()) {
      const elementHandle = property.asElement() as dom.ElementHandle<Element>;
      if (elementHandle)
        result.push(elementHandle);
      else
        property.dispose();
    }
    return result;
  }

  _waitForSelectorTask(selector: string, waitFor: 'attached' | 'detached' | 'visible' | 'hidden', deadline: number): { world: 'main' | 'utility', task: (context: dom.FrameExecutionContext) => Promise<js.JSHandle> } {
    const parsed = this._parseSelector(selector);
    const task = async (context: dom.FrameExecutionContext) => context.evaluateHandleInternal(({ evaluator, parsed, waitFor, timeout }) => {
      const polling = (waitFor === 'attached' || waitFor === 'detached') ? 'mutation' : 'raf';
      return evaluator.injected.poll(polling, timeout, () => {
        const element = evaluator.querySelector(parsed, document);
        switch (waitFor) {
          case 'attached':
            return element || false;
          case 'detached':
            return !element;
          case 'visible':
            return element && evaluator.injected.isVisible(element) ? element : false;
          case 'hidden':
            return !element || !evaluator.injected.isVisible(element);
        }
      });
    }, { evaluator: await this._prepareEvaluator(context), parsed, waitFor, timeout: helper.timeUntilDeadline(deadline) });
    return { world: this._needsMainContext(parsed) ? 'main' : 'utility', task };
  }

  async _createSelector(name: string, handle: dom.ElementHandle<Element>): Promise<string | undefined> {
    const mainContext = await handle._page.mainFrame()._mainContext();
    return mainContext.evaluateInternal(({ evaluator, target, name }) => {
      return evaluator.engines.get(name)!.create(document.documentElement, target);
    }, { evaluator: await this._prepareEvaluator(mainContext), target: handle, name });
  }

  private _parseSelector(selector: string): types.ParsedSelector {
    let index = 0;
    let quote: string | undefined;
    let start = 0;
    const result: types.ParsedSelector = [];
    const append = () => {
      const part = selector.substring(start, index).trim();
      const eqIndex = part.indexOf('=');
      let name: string;
      let body: string;
      if (eqIndex !== -1 && part.substring(0, eqIndex).trim().match(/^[a-zA-Z_0-9-]+$/)) {
        name = part.substring(0, eqIndex).trim();
        body = part.substring(eqIndex + 1);
      } else if (part.startsWith('"')) {
        name = 'text';
        body = part;
      } else if (/^\(*\/\//.test(part)) {
        // If selector starts with '//' or '//' prefixed with multiple opening
        // parenthesis, consider xpath. @see https://github.com/microsoft/playwright/issues/817
        name = 'xpath';
        body = part;
      } else {
        name = 'css';
        body = part;
      }
      name = name.toLowerCase();
      if (!this._builtinEngines.has(name) && !this._engines.has(name))
        throw new Error(`Unknown engine ${name} while parsing selector ${selector}`);
      result.push({ name, body });
    };
    while (index < selector.length) {
      const c = selector[index];
      if (c === '\\' && index + 1 < selector.length) {
        index += 2;
      } else if (c === quote) {
        quote = undefined;
        index++;
      } else if (!quote && c === '>' && selector[index + 1] === '>') {
        append();
        index += 2;
        start = index;
      } else {
        index++;
      }
    }
    append();
    return result;
  }
}

export const selectors = new Selectors();
