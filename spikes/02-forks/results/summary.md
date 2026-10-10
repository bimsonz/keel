| run | n | ok | colo / placement | fork() p50 / p95 / max | ready p50 / p95 / max | span first fork→last ready | slope ms/rank | delete p50 | non-ready reasons seen |
|---|---|---|---|---|---|---|---|---|---|
| smoke | 1 | 1 | LHR / default | 3791 / 3791 / 3791 | 3618 / 3618 / 3618 | 3618 | null | 2213 | get:NOT_FOUND×1, get:FORK_IN_PROGRESS×1 |
| smoke-placed | 2 | 2 | LHR / remote-SEA | 2111 / 3618 / 3618 | 1622 / 3483 / 3483 | 8408 | null | 1859 | get:FORK_IN_PROGRESS×3 |
| single-1m-lhr | 10 | 10 | LHR / default | 3315 / 3772 / 3772 | 3024 / 3459 / 3459 | 48891 | 5198 | 1806 | get:FORK_IN_PROGRESS×11, get:NOT_FOUND×4 |
| single-1m-sea | 10 | 10 | LHR / remote-SEA | 2806 / 4161 / 4161 | 2934 / 4218 / 4218 | 51492 | 5393 | 1520 | get:FORK_IN_PROGRESS×12 |
| single-50m-lhr | 10 | 10 | LHR / default | 5242 / 11831 / 11831 | 4804 / 11504 / 11504 | 70682 | 6498 | 1576 | get:NOT_FOUND×4, get:FORK_IN_PROGRESS×36 |
| single-50m-sea | 10 | 10 | LHR / remote-SEA | 4648 / 6811 / 6811 | 4071 / 6691 / 6691 | 68517 | 7299 | 1460 | get:FORK_IN_PROGRESS×34, get:NOT_FOUND×1 |
| single-300m-sea | 3 | 3 | LHR / remote-SEA | 27330 / 60138 / 60138 | 32014 / 62454 / 62454 | 113460 | 25503 | 1849 | get:FORK_IN_PROGRESS×66, get:NOT_FOUND×1 |
| conc20-1m-lhr | 20 | 20 | LHR / default | 3144 / 3704 / 3707 | 3079 / 3649 / 3766 | 4216 | 121 | 1761 | get:FORK_IN_PROGRESS×22, get:NOT_FOUND×1 |
| conc20-1m-sea | 20 | 20 | LHR / remote-SEA | 2132 / 3192 / 3468 | 1965 / 3012 / 3086 | 3226 | 103 | 1599 | get:NOT_FOUND×5, get:FORK_IN_PROGRESS×20 |
| conc20-50m-lhr | 20 | 20 | CDG,LHR / default | 4811 / 6868 / 7422 | 4531 / 6467 / 7187 | 7471 | 192 | 2005 | get:FORK_IN_PROGRESS×54, get:NOT_FOUND×5 |
| conc20-50m-sea | 20 | 20 | LHR,CDG / remote-SEA | 4604 / 6079 / 7103 | 4397 / 5879 / 7176 | 7206 | 147 | 1455 | get:FORK_IN_PROGRESS×61, get:NOT_FOUND×2 |
| conc100-1m-lhr | 100 | 100 | LHR,CDG / default | 3243 / 4238 / 6549 | 2933 / 3945 / 7191 | 7591 | 34 | 1994 | get:FORK_IN_PROGRESS×115, get:NOT_FOUND×6 |
| conc100-1m-sea | 100 | 100 | CDG,LHR / remote-SEA | 2832 / 4080 / 4562 | 2694 / 3867 / 4393 | 5425 | 31 | 1594 | get:FORK_IN_PROGRESS×106, get:NOT_FOUND×11 |
| conc100-50m-sea | 100 | 100 | LHR,CDG / remote-SEA | 4913 / 7508 / 8431 | 4613 / 7190 / 8592 | 8730 | 40 | 1585 | get:NOT_FOUND×29, get:FORK_IN_PROGRESS×283 |
| forked-event-nofilter | 2 | 2 | CDG / remote-SEA | 1803 / 2111 / 2111 | 1401 / 2001 / 2001 | 5250 | null | 965 | get:NOT_FOUND×2, get:FORK_IN_PROGRESS×3 |
