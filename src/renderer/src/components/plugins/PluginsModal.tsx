import { useState } from 'react'
import { Dialog } from '../Dialog'
import { MarketplaceSources, PluginBrowser } from './PluginsPanel'

const base = (p: string) => p.split('/').filter(Boolean).pop() ?? p

/** Folder menu → Plugins…: browse marketplaces and install plugins into this folder. */
export function PluginsModal({ folder, onClose }: { folder: string; onClose(): void }) {
  const [tab, setTab] = useState<'browse' | 'sources'>('browse')
  const [key, setKey] = useState(0)
  return (
    <Dialog id="plugins" className="tm" title={<>Plugins · <span title={folder}>{base(folder)}</span></>} onClose={onClose}>
        <div className="tabs">
          <button className={tab === 'browse' ? 'on' : ''} onClick={() => setTab('browse')}>Browse</button>
          <button className={tab === 'sources' ? 'on' : ''} onClick={() => setTab('sources')}>Marketplaces</button>
        </div>
        {tab === 'browse' && <PluginBrowser key={key} folder={folder} onManage={() => setTab('sources')} />}
        {tab === 'sources' && <MarketplaceSources folder={folder} onSaved={() => { setKey((k) => k + 1); setTab('browse') }} />}
    </Dialog>
  )
}
