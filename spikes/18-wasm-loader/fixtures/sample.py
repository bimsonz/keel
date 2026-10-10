import os, sys
from typing import List


def total(xs : List[int])->int:
    acc=0
    for x in xs :
        if x == None:
            continue
        acc+=x
    return acc

class Greeter :
    def __init__(self,name):
        self.name=name
    def greet(self):
        unused = 1
        return f"hello {self.name}"
