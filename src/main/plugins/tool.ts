import type { ToolDef } from '../../engine/tools/types'
import type { PluginService } from './service'

const ACTIONS = ['status', 'list', 'install', 'uninstall', 'check_updates', 'update_all', 'open_panel'] as const
const WRITE = new Set(['install', 'uninstall', 'update_all'])

/** Lets the agent list, install and update marketplace plugins for the chat's working folder. */
export function pluginsTool(svc: PluginService, openPanel: (folder: string) => void): ToolDef {
  return {
    name: 'folder_plugins',
    description: 'List, install, remove or update marketplace plugins (skills and agents) for the current working folder. ' +
      'Plugins go into the folder\'s .github/ and only apply to chats in this folder. New skills load in new chats. ' +
      'Use "open_panel" to show the Plugins panel, e.g. when the user wants to add a marketplace.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: [...ACTIONS] },
        plugin: { type: 'string', description: 'Plugin name (install / uninstall).' },
        marketplace: { type: 'string', description: 'Marketplace name; defaults to the first one that lists the plugin.' }
      },
      required: ['action']
    },
    summarize: (a) => `Plugins: ${a.action}${a.plugin ? ` ${a.plugin}` : ''}`,
    async run(a, ctx) {
      const folder = ctx.cwd
      if (WRITE.has(a.action) && !(await ctx.gate.check(ctx.agentId, 'write', `Plugins: ${a.action}${a.plugin ? ` ${a.plugin}` : ''} in ${folder}/.github`))) {
        return 'The user declined.'
      }
      switch (a.action) {
        case 'status': {
          const s = svc.status(folder)
          return JSON.stringify({ marketplaces: s.config.marketplaces, installed: s.plugins.map((p) => `${p.name} ${p.version ?? ''}`.trim()), update: s.update }, null, 2)
        }
        case 'list': {
          const { plugins, errors } = await svc.listPlugins(folder)
          if (!plugins.length && !errors.length) return 'No marketplaces are set up for this folder. Use open_panel so the user can add one.'
          return JSON.stringify({ plugins: plugins.map((p) => ({ name: p.name, marketplace: p.marketplace, version: p.version, installed: p.installed, managedBy: p.managed, description: p.description })), errors })
        }
        case 'install':
        case 'uninstall': {
          if (!a.plugin) return 'Say which plugin.'
          if (a.action === 'uninstall') return (await svc.uninstallPlugin(folder, a.plugin)).message
          let mp = a.marketplace
          if (!mp) mp = (await svc.listPlugins(folder)).plugins.find((p) => p.name === a.plugin)?.marketplace
          if (!mp) return `No marketplace lists “${a.plugin}”.`
          const r = await svc.installPlugin(folder, a.plugin, mp, ctx.signal)
          return r.ok ? `${r.message} Its skills and agents are available in new chats in this folder.` : r.message
        }
        case 'check_updates': { const u = await svc.checkUpdates(folder, ctx.signal); return u ? `Updates: ${u.plugins.join(', ')}` : 'All plugins are up to date.' }
        case 'update_all': return (await svc.updateAll(folder, ctx.signal)).message
        case 'open_panel': openPanel(folder); return 'Opened the Plugins panel.'
        default: return `Unknown action. Use one of: ${ACTIONS.join(', ')}.`
      }
    }
  }
}
