# Diagnostic companion for SQLite's official test/busy2.test.
#
# Run from a SQLite testrunner workdir where test/ and testfixture are present:
#   testfixture /path/to/scripts/sqlite-busy2-measure.tcl
#
# This does not replace or modify the official test. It prints the raw Tcl
# [time] measurement for the first busy-handler timeout check so Kandelo
# scheduler/kernel timing can be diagnosed.

set ::tcl_platform(os) OpenBSD
set ::tcl_platform(platform) unix
set argv0 test/busy2.test

set testdir test
source $testdir/tester.tcl
source $testdir/lock_common.tcl
set testprefix busy2measure

do_multiclient_test tn {
  do_test 1.$tn.0 {
    sql2 {
      CREATE TABLE t1(a, b);
      PRAGMA journal_mode = wal;
      INSERT INTO t1 VALUES('A', 'B');
    }
  } {wal}

  do_test 1.$tn.1 {
    code1 { db timeout 1000 }
    sql1 { SELECT * FROM t1 }
  } {A B}

  do_test 1.$tn.2 {
    sql2 {
      BEGIN;
        INSERT INTO t1 VALUES('C', 'D');
    }
  } {}

  do_test 1.$tn.3 {
    set us [lindex [time { catch { sql1 { BEGIN EXCLUSIVE } } }] 0]
    puts "KDL_BUSY2_MEASURE tn=$tn us=$us"
    expr {$us>950000 && $us<1500000}
  } {1}

  do_test 1.$tn.4 {
    sql2 {
      COMMIT
    }
  } {}
}

finish_test
