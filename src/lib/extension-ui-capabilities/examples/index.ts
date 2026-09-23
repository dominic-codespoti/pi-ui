import { EXAMPLE_IDS, type ExampleId, type ExampleModule } from '../types.ts';
import { example as selectList } from './select-list.ts';
import { example as settingsList } from './settings-list.ts';
import { example as textInput } from './text-input.ts';
import { example as multilineEditor } from './multiline-editor.ts';
import { example as markdownSummary } from './markdown-summary.ts';
import { example as plainText } from './plain-text.ts';
import { example as loader } from './loader.ts';
import { example as image } from './image.ts';
import { example as hstackLayout } from './hstack-layout.ts';
import { example as buttonShape } from './button-shape.ts';
import { example as checkboxShape } from './checkbox-shape.ts';
import { example as liveProgressWidget } from './live-progress-widget.ts';
import { example as keyboardOverlay } from './keyboard-overlay.ts';

const BY_ID = {
  'select-list': selectList,
  'settings-list': settingsList,
  'text-input': textInput,
  'multiline-editor': multilineEditor,
  'markdown-summary': markdownSummary,
  'plain-text': plainText,
  loader,
  image,
  'hstack-layout': hstackLayout,
  'button-shape': buttonShape,
  'checkbox-shape': checkboxShape,
  'live-progress-widget': liveProgressWidget,
  'keyboard-overlay': keyboardOverlay,
} satisfies Record<ExampleId, ExampleModule>;

export const EXAMPLES: readonly ExampleModule[] = EXAMPLE_IDS.map((id) => BY_ID[id]);

export function exampleById(id: ExampleId): ExampleModule {
  return BY_ID[id];
}
