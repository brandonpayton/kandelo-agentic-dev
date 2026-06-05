#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/mman.h>
#include <sys/wait.h>
#include <unistd.h>

static int wait_ok(pid_t pid) {
    int status = 0;
    if (waitpid(pid, &status, 0) < 0) {
        perror("waitpid");
        return 0;
    }
    if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) {
        fprintf(stderr, "child failed: status=%d\n", status);
        return 0;
    }
    return 1;
}

int main(void) {
    const char *path = "/tmp/mmap_shared_cross_process";
    const long page_size = sysconf(_SC_PAGESIZE);
    if (page_size <= 0) {
        perror("sysconf");
        return 1;
    }

    int fd = open(path, O_CREAT | O_RDWR | O_TRUNC, 0644);
    if (fd < 0) {
        perror("open parent");
        return 1;
    }
    if (ftruncate(fd, page_size) < 0) {
        perror("ftruncate");
        return 1;
    }

    char *parent = mmap(NULL, page_size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    if (parent == MAP_FAILED) {
        perror("mmap parent");
        return 1;
    }

    parent[0] = 'A';
    pid_t pid = fork();
    if (pid < 0) {
        perror("fork inherited");
        return 1;
    }
    if (pid == 0) {
        if (parent[0] != 'A') {
            fprintf(stderr, "inherited mapping did not see parent write: %c\n", parent[0]);
            _exit(2);
        }
        parent[0] = 'B';
        (void)getpid();
        _exit(0);
    }
    if (!wait_ok(pid)) return 1;
    if (parent[0] != 'B') {
        fprintf(stderr, "parent did not see inherited child write: %c\n", parent[0]);
        return 1;
    }
    printf("inherited mapping coherent\n");

    parent[1] = 'C';
    pid = fork();
    if (pid < 0) {
        perror("fork separate");
        return 1;
    }
    if (pid == 0) {
        int child_fd = open(path, O_RDWR);
        if (child_fd < 0) {
            perror("open child");
            _exit(3);
        }
        char *child = mmap(NULL, page_size, PROT_READ | PROT_WRITE, MAP_SHARED, child_fd, 0);
        if (child == MAP_FAILED) {
            perror("mmap child");
            _exit(4);
        }
        close(child_fd);
        if (child[1] != 'C') {
            fprintf(stderr, "separate mapping did not see parent write: %c\n", child[1]);
            _exit(5);
        }
        child[1] = 'D';
        if (munmap(child, page_size) < 0) {
            perror("munmap child");
            _exit(6);
        }
        _exit(0);
    }
    if (!wait_ok(pid)) return 1;
    if (parent[1] != 'D') {
        fprintf(stderr, "parent did not see separate child write: %c\n", parent[1]);
        return 1;
    }
    printf("separate mapping coherent\n");

    if (msync(parent, page_size, MS_SYNC) < 0) {
        perror("msync parent");
        return 1;
    }
    if (munmap(parent, page_size) < 0) {
        perror("munmap parent");
        return 1;
    }
    close(fd);
    unlink(path);
    printf("PASS\n");
    return 0;
}
