#!/usr/bin/env python3
"""Regression checks for session IDs and complete JSON metadata."""
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
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


if __name__ == '__main__':
    unittest.main()
