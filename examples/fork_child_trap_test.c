#include <signal.h>
#include <stdio.h>
#include <sys/wait.h>
#include <unistd.h>

int main(void) {
  pid_t pid = fork();
  if (pid < 0) {
    perror("fork");
    return 1;
  }

  if (pid == 0) {
    fprintf(stderr, "child-before-trap\n");
    __builtin_trap();
    fprintf(stderr, "child-after-trap\n");
    _exit(99);
  }

  int status = 0;
  pid_t got = waitpid(pid, &status, 0);
  if (got < 0) {
    perror("waitpid");
    return 2;
  }

  fprintf(
    stderr,
    "parent-waited pid=%d status=%d signaled=%d signal=%d exited=%d code=%d\n",
    (int)got,
    status,
    WIFSIGNALED(status),
    WIFSIGNALED(status) ? WTERMSIG(status) : 0,
    WIFEXITED(status),
    WIFEXITED(status) ? WEXITSTATUS(status) : 0
  );

  if (got == pid && WIFSIGNALED(status) && WTERMSIG(status) == SIGSEGV) {
    fprintf(stderr, "parent-saw-child-crash\n");
    return 0;
  }

  return 3;
}
