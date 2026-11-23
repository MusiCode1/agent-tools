#!/usr/bin/env python3
"""Regression checks for session IDs, JSON metadata, word filtering and the comms source."""
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest


ASK = Path(__file__).with_name('ask')


class SessionLookupTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='ask-session-test-')
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        db = self.home / 'sessions.db'
        config = self.home / '.config/agent-sessions/config.json'
        config.parent.mkdir(parents=True)
        config.write_text(json.dumps({'db_path':str(db)}))
        self.target = '--home-user--/common-d3bf0b65/2026-11-05_d3bf0b65_target'
        sibling = '--home-user--/common-d3bf0b65/2026-11-05_a88383c9_sibling'
        with sqlite3.connect(db) as con:
            con.execute('create table sessions (session_id text, machine text, cli text, project text, cwd text, title text, started_at integer, ended_at integer, model text, model_provider text, parent_session_id text, usage text, meta text)')
            con.execute('create table messages (session_id text, role text, model text, ts integer, text text, seq integer)')
            for sid, project in ((self.target, 'fixture-project'), (sibling, 'foreign-project')):
                con.execute('insert into sessions values (?,?,?,?,?,?,?,?,?,?,?,?,?)',
                            (sid,'test-machine','codex',project,'/tmp','Example',1,2,'test-model','test-provider',None,'{"tokens":3}','{"key":"value"}'))
                con.execute('insert into messages values (?,?,?,?,?,?)', (sid,'user','test-model',1,'hello',1))
            con.execute("create virtual table messages_fts using fts5(text, content='messages', content_rowid='rowid', tokenize='trigram')")
            con.execute("insert into messages_fts(messages_fts) values('rebuild')")

    def ask(self, *args):
        env = {**os.environ, 'HOME':str(self.home)}
        return subprocess.run([sys.executable,str(ASK),*args],env=env,text=True,capture_output=True)

    def test_short_id_ignores_parent_directory_matches(self):
        result = self.ask('session','d3bf0b65','--json')
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(json.loads(result.stdout)['session']['id'],self.target)

    def test_full_id_starting_dash_and_complete_metadata(self):
        result = self.ask('session','--json','--',self.target)
        self.assertEqual(result.returncode,0,result.stderr)
        session = json.loads(result.stdout)['session']
        self.assertEqual(session['session_id'],self.target)
        self.assertEqual(session['id'],self.target)
        self.assertEqual(session['machine'],'test-machine')
        self.assertEqual(session['ended_at'],2)
        self.assertEqual(session['model_provider'],'test-provider')
        self.assertEqual(session['usage'],'{"tokens":3}')
        self.assertEqual(session['meta'],'{"key":"value"}')
        human = self.ask('session','--',self.target)
        self.assertEqual(human.returncode,0,human.stderr)
        self.assertIn('Example',human.stdout)

    def test_search_project_fragment_counts_only_matching_sessions(self):
        result = self.ask('hello','--sessions','--project','xture','--json')
        self.assertEqual(result.returncode,0,result.stderr)
        sessions = json.loads(result.stdout)['results'][0]
        self.assertEqual(sessions['total'],1)
        self.assertEqual([hit['session'] for hit in sessions['hits']],[self.target])
        self.assertEqual(sessions['hits'][0]['title'],'Example')
        self.assertEqual(sessions['hits'][0]['cwd'],'/tmp')

    def test_search_prefers_recently_ingested_messages(self):
        result = self.ask('hello','--sessions','--json','-n','2')
        self.assertEqual(result.returncode,0,result.stderr)
        sessions = json.loads(result.stdout)['results'][0]
        self.assertEqual(sessions['total'],2)
        self.assertEqual([hit['project'] for hit in sessions['hits']],
                         ['foreign-project','fixture-project'])

    def test_search_term_with_hyphen_and_path(self):
        with sqlite3.connect(self.home / 'sessions.db') as con:
            con.execute('insert into messages values (?,?,?,?,?,?)',
                        (self.target,'user','test-model',3,'run agents-kb-tools from portal/scripts',2))
            con.execute("insert into messages_fts(messages_fts) values('rebuild')")
        for term in ('agents-kb-tools', 'portal/scripts'):
            result = self.ask(term,'--sessions','--json')
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertEqual(json.loads(result.stdout)['results'][0]['total'],1)

    def test_phrase_and_hebrew_prefix_survive_word_filter(self):
        with sqlite3.connect(self.home / 'sessions.db') as con:
            for seq, text in ((3, 'run git worktree prune now'), (4, 'אני מאחר לפגישה של הצוות')):
                con.execute('insert into messages values (?,?,?,?,?,?)', (self.target,'user','test-model',seq,text,seq))
            con.execute("insert into messages_fts(messages_fts) values('rebuild')")
        for term in ('"worktree prune"', 'פגישה'):
            result = self.ask(term,'--sessions','--json')
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertEqual(len(json.loads(result.stdout)['results'][0]['hits']),1,term)


def load_script(path, name):
    loader = importlib.machinery.SourceFileLoader(name, str(path))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


ask_mod = load_script(ASK, 'ask_mod')
comms_index = load_script(ASK.parent.parent / 'comms-index' / 'comms-index', 'comms_index_mod')


class WordFilterTest(unittest.TestCase):
    def test_hebrew_prefixes(self):
        ok = ask_mod.word_filter('פגישה', need_all=True)
        for text in ('נקבעה פגישה מחר', 'אני מאחר לפגישה', 'והפגישה בוטלה', 'כשהפגישה נגמרה', 'פגישה.'):
            self.assertTrue(ok(text), text)
        for text in ('פגישות השבוע', 'הפגישהזו', 'סיפגישה'):
            self.assertFalse(ok(text), text)

    def test_latin_boundaries_and_phrases(self):
        self.assertFalse(ask_mod.word_filter('rust', True)('trust me'))
        self.assertTrue(ask_mod.word_filter('rust', True)('Rust is fine'))
        phrase = ask_mod.word_filter('"worktree prune"', need_all=False)
        self.assertTrue(phrase('run git worktree  prune now'))
        self.assertFalse(phrase('worktree list then prune'))

    def test_all_any_and_prefix_star(self):
        both = ask_mod.word_filter('פגישה מחר', need_all=True)
        self.assertTrue(both('הפגישה מחר'))
        self.assertFalse(both('הפגישה היום'))
        self.assertTrue(ask_mod.word_filter('פגישה OR ישיבה', need_all=True)('הישיבה נדחתה'))
        self.assertTrue(ask_mod.word_filter('פגיש*', need_all=True)('בפגישות'))


class CommsSearchTest(unittest.TestCase):
    T0 = 1767254400

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='ask-comms-test-')
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.db = self.home / 'state' / 'comms.db'
        config = self.home / '.config/comms-index/config.json'
        config.parent.mkdir(parents=True)
        config.write_text(json.dumps({'db_path': str(self.db)}))
        con = comms_index.open_db(str(self.db))
        t = self.T0
        comms_index.sync_rows(con, 'wa', 'personal', [
            ('c1/m1', 'c1', 'דנה', 'דנה', 0, t, 'נקבעה פגישה ביום שני'),
            ('c1/m2', 'c1', 'דנה', '', 1, t + 60, 'אני מאחר לפגישה'),
            ('c1/m3', 'c1', 'דנה', 'דנה', 0, t + 120, 'פגישות השבוע מבוטלות'),
            ('c1/m4', 'c1', 'דנה', 'דנה', 0, t + 180, 'כן'),
        ])
        comms_index.sync_rows(con, 'sms', 'phone', [
            ('1:x', '7', 'Example Clinic', 'Example Clinic', 0, t + 240, 'תזכורת: הפגישה מחר ב-10'),
        ])
        now = int(time.time())
        comms_index.state_set(con, 'wa', 'personal', last_update=now)
        comms_index.state_set(con, 'sms', 'phone', last_pull_ok=now, phone_last_run=now)
        con.commit()
        self.refs = dict(con.execute('select ext_id, ref from messages'))
        con.close()

    def ask(self, *args):
        env = {**os.environ, 'HOME': str(self.home)}
        return subprocess.run([sys.executable, str(ASK), *args], env=env, text=True, capture_output=True)

    def search(self, *args):
        result = self.ask(*args, '--json')
        self.assertEqual(result.returncode, 0, result.stderr)
        out = json.loads(result.stdout)
        return out, next((r for r in out['results'] if r['source'] == 'comms'), None)

    def test_comms_is_never_a_default_source(self):
        out, comms = self.search('פגישה')
        self.assertEqual(out['sources'], ['knowledge', 'sessions'])
        self.assertIsNone(comms)

    def test_prefixed_forms_found_plural_not(self):
        _, comms = self.search('פגישה', '--comms')
        self.assertEqual({h['ref'] for h in comms['hits']},
                         {self.refs['c1/m1'], self.refs['c1/m2'], self.refs['1:x']})
        self.assertEqual(comms['hits'][0]['channel'], 'sms', 'החדשה ביותר ראשונה')
        _, loose = self.search('פגישה', '--comms', '--no-word')
        self.assertEqual(len(loose['hits']), 3, 'trigram אינו מוצא פגישות — שורש אחר')
        _, stem = self.search('פגיש', '--comms', '--no-word')
        self.assertEqual(len(stem['hits']), 4)

    def test_filters_and_short_terms(self):
        _, sms = self.search('פגישה', '--comms', '--channel', 'sms')
        self.assertEqual([h['ref'] for h in sms['hits']], [self.refs['1:x']])
        _, chat = self.search('פגישה', '--comms', '--chat', 'דנה')
        self.assertEqual(len(chat['hits']), 2)
        _, short = self.search('כן', '--comms')
        self.assertEqual([h['ref'] for h in short['hits']], [self.refs['c1/m4']])

    def test_msg_shows_context(self):
        result = self.ask('msg', self.refs['c1/m2'])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('# דנה · wa/personal', result.stdout)
        marked = [line for line in result.stdout.splitlines() if line.startswith('▶')]
        self.assertEqual(len(marked), 1)
        self.assertIn('אני: אני מאחר לפגישה', marked[0])
        self.assertIn('נקבעה פגישה ביום שני', result.stdout)
        data = json.loads(self.ask('msg', self.refs['c1/m2'][:8], '--around', '1', '--json').stdout)
        self.assertEqual([m['match'] for m in data['messages']], [False, True, False])

    def test_stale_and_missing_index(self):
        con = sqlite3.connect(self.db)
        comms_index.state_set(con, 'wa', 'personal', last_update=int(time.time()) - 5 * 3600)
        con.commit()
        con.close()
        out, _ = self.search('פגישה', '--comms')
        self.assertTrue(any('wa/personal' in w for w in out['warnings']), out['warnings'])
        self.db.unlink()
        _, comms = self.search('פגישה', '--comms')
        self.assertIn('comms-index update', comms['error'])


if __name__ == '__main__':
    unittest.main()
