/** Single Loader entry; progress protocol and compatibility only. */
import {createCore} from './host/core.js'
import {attach as observer} from './host/observer.js'
import {attach as generator} from './host/generator.js'
import {attach as api} from './host/api.js'
export function apply(ctx, config={}) { const core=createCore(ctx,config);ctx.provide('planCompletion',core);generator(ctx,core);observer(ctx,core);api(ctx,core);return core }
