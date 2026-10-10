#include <stdio.h>
#include <stdlib.h>
struct point{int x;int y;};
static int dist2(struct point a,struct point b){int dx=a.x-b.x;int dy=a.y-b.y;return dx*dx+dy*dy;}
int main(int argc,char**argv){
struct point p={1,2},q={4,6};
if(argc>1){printf("%s\n",argv[1]);}else{printf("%d\n",dist2(p,q));}
for(int i=0;i<3;i++){ if(i%2==0) continue; printf("odd %d\n",i);}
return 0;}
